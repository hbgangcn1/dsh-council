import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, readdir, stat, rename } from 'node:fs/promises'

// dsh-council：Model Council v14+ 宿主插件。
// - 工具 run_council：后台跑 Python orchestrator（council_v14.py），report/inline 双模式；
//   退出码/timedOut 显式检查（M3），杜绝 python 崩溃静默回退旧报告
// - 工具 council_status：run 摘要 + 能力档案概览 + 陈旧语义 + 成本对账 + 护栏命中
// - HTTP /api/council/state + /api/council/settings：Council 控制台 UI 数据读写
//   （~/.dsh/council/*.json 文件是唯一数据源，原子写）
// - HTTP /metrics：Prometheus 指标（revision/drift/guardrail_hits/feedback_ring/cfets_stale）
// - 汇率每日 09:30 定时更新（CFETS 中间价，fetch_exchange_rate.py，北京时间口径）
// v15（2026-08-24 council 评审 H1-H4/M1-M4/L1-L3 落地，见 AGENTS.md 同期记录）
export default {
  name: 'council',
  inject: ['tools', 'webServer', 'shell', 'timer', 'credentials', 'llm', 'web'],
  apply(ctx) {
    const shell = ctx.shell
    const COUNCIL_DIR = join(homedir(), '.dsh', 'council')
    const ORCH = join(COUNCIL_DIR, 'orchestrator')

    // v15.12c（2026-09-14 实测踩到）：原来用 `\"` 转义双引号——那是 C/JSON 的规矩，
    // **PowerShell 不认**（PS 双引号字符串里 `\"` 会被当成字面反斜杠 + 结束引号）。
    // 后果：任务文本里只要出现 ASCII 双引号，参数就被提前截断 → argparse 退出码 2。
    // 之前几次任务用的都是中文引号「」，所以一直没暴露。
    // 改用 PS 单引号字面量（内部单引号翻倍），双引号 / 反斜杠 / $ / 换行 全部安全。
    function psArg(s) { return "'" + String(s).replace(/'/g, "''") + "'" }

    function py(script, ...args) {
      const safe = args.map(function (a) { return psArg(a) })
      return 'python ' + psArg(join(ORCH, script)) + ' ' + safe.join(' ')
    }

    // M3：shell.run 只对基础设施失败 reject；非零退出码会 resolve，必须显式检查，
    // 否则 python 崩溃时静默回退到旧 run 的 result.json（可观测性盲区）。
    // 退出码/超时的统一校验（M3：shell.run 只对基础设施失败 reject；非零退出码会 resolve，
    // 必须显式检查，否则 python 崩溃时静默回退到旧 run 的 result.json）。
    function assertExitOk(res, label) {
      const tail = function (s) {
        const t = (s && s.text || '').trim()
        return t ? t.split('\n').slice(-12).join('\n') : ''
      }
      const errTail = tail(res.stderr)
      const outTail = tail(res.stdout)
      if (res.exitCode !== 0) {
        throw new Error(label + ' 退出码 ' + res.exitCode +
          (errTail ? '；stderr 尾部：\n' + errTail : '') +
          (outTail ? '；stdout 尾部：\n' + outTail : ''))
      }
      return res
    }

    async function runShellChecked(spec) {
      const res = await shell.run(spec)
      if (res.timedOut) {
        throw new Error('council python 执行超时（timeoutMs=' + spec.timeoutMs + '，timedOut=true）')
      }
      return assertExitOk(res, 'council python')
    }

    async function readJson(path) {
      try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { return null }
    }

    async function writeJsonAtomic(path, obj) {
      const tmp = path + '.tmp'
      await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n')
      await rename(tmp, path)
    }

    // ---- v15.12（2026-09-14 Robert 拍板 B 方案）：分离启动 + 轮询 ----
    // 动因：`dsh-pwsh-local` 的配置默认值里 `maxTimeoutMs = 600000`，语义是
    // 「每次调用 timeoutMs 覆盖值的上限」——它会**静默**把 shell.resolve 的 timeoutMs
    // 钳到 600s。council 一次 run 实测 800–1900s（fast 档墙钟就 1320s），
    // 所以走 shell 阻塞调用必被杀：2026-09-14 实测 fast 档 run 在 600s 报 timedOut
    // 且不产出报告。宿主超时改多大都没用，因为天花板在这一层。
    //
    // 解法：把 python 以**分离进程**（Start-Process）启动，shell 调用只负责"点火"
    // 并立刻返回（60s 足够），插件侧改成轮询文件系统等 result.json / 退出码文件。
    // 附带收益：python 不再挂在 shell 调用生命周期上，DSH 重启也杀不掉正在跑的 run。
    const DETACH_DIR = join(COUNCIL_DIR, 'scratch', 'detached')

    function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'" }

    async function readFileText(p) {
      try { return await readFile(p, 'utf8') } catch (e) { return null }
    }

    function sleep(ms) {
      return new Promise(function (resolve) { ctx.setTimeout(resolve, ms) })
    }

    // 启动分离 python，返回句柄；不做等待
    async function spawnDetached(command, workdir) {
      const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
      const dir = join(DETACH_DIR, token)
      await mkdir(dir, { recursive: true })
      const h = {
        token: token, dir: dir,
        stdoutPath: join(dir, 'stdout.txt'),
        stderrPath: join(dir, 'stderr.txt'),
        exitPath: join(dir, 'exit.txt'),
        pidPath: join(dir, 'pid.txt'),
      }
      const wrapper = join(dir, 'run.ps1')
      // 编码三件套必须有：PV7 下 [Console]::OutputEncoding 默认是系统 ANSI（中文机为 GBK），
      // 不显式设 UTF-8 的话 python 打的中文 JSON 会被打成乱码、下游 parse 全废。
      const body = [
        '$ErrorActionPreference = "Continue"',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$env:PYTHONIOENCODING = "utf-8"',
        '$PID | Out-File -FilePath ' + psQuote(h.pidPath) + ' -Encoding ascii',
        'Set-Location -LiteralPath ' + psQuote(workdir),
        '& ' + command + ' 2> ' + psQuote(h.stderrPath) +
          ' | Out-File -FilePath ' + psQuote(h.stdoutPath) + ' -Encoding utf8',
        '$code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
        '$code | Out-File -FilePath ' + psQuote(h.exitPath) + ' -Encoding ascii',
      ].join("\r\n")
      await writeFile(wrapper, body, 'utf8')

      // 点火脚本独立成文件：2026-09-14 首次实测失败，怀疑点有两个——
      // ① shell 命令里内嵌 `-ArgumentList "..."` 会被外层 pwsh -Command 的引号层搅掉；
      //    改成 `-File launch.ps1` 后命令里只剩一个双引号包住的路径，无引号博弈。
      // ② 受限令牌（workspace-write）下 Start-Process 可能起不来/子进程被回收。
      //    与 AGENTS.md 里「toast 通知在受限令牌下必失败、需 danger-full-access」同类，
      //    此处同样用 danger-full-access **只为点火这一次调用**（它除了 Start-Process
      //    什么都不干），真正干活的 python 由 wrapper 自己拉起、继承的也是完整令牌。
      // 点火失败不再静默：launch.ps1 把异常写进 launch-error.txt，下面显式检查。
      const launchedPath = join(dir, 'launched.txt')
      const launchErrPath = join(dir, 'launch-error.txt')
      const launchBody = [
        '$ErrorActionPreference = "Stop"',
        'try {',
        '  $p = Start-Process -FilePath pwsh -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",' +
          psQuote(wrapper) + ') -WindowStyle Hidden -PassThru',
        '  $p.Id | Out-File -FilePath ' + psQuote(launchedPath) + ' -Encoding ascii',
        '} catch {',
        '  ("LAUNCH_ERROR: " + $_.Exception.Message) | Out-File -FilePath ' + psQuote(launchErrPath) + ' -Encoding utf8',
        '  exit 1',
        '}',
      ].join("\r\n")
      const launchScript = join(dir, 'launch.ps1')
      await writeFile(launchScript, launchBody, 'utf8')

      const sp = ctx.get('sandboxPolicy')
      let policy = { mode: 'workspace-write', workspaceRoot: COUNCIL_DIR }
      if (sp !== undefined) {
        const base = sp.resolve()
        policy = { mode: 'danger-full-access', workspaceRoot: base.workspaceRoot }
      }
      const launch = shell.resolve({
        command: 'pwsh -NoProfile -ExecutionPolicy Bypass -File "' + launchScript + '"',
        timeoutMs: 60000,
        sandboxPolicy: policy,
      })
      const res = await shell.run(launch)
      const launchErr = await readFileText(launchErrPath)
      if (res.timedOut || res.exitCode !== 0 || launchErr) {
        throw new Error('启动 council 分离进程失败：' + (launchErr || '') +
          ' | ' + (((res.stderr && res.stderr.text) || '') + ((res.stdout && res.stdout.text) || '')).slice(-300))
      }
      // 活性自检：等 wrapper 写下 pid.txt（它几乎是第一件事）。没有就说明分离进程没活下来——
      // 必须在这里快速失败，否则下游轮询会一路空等到 45 分钟 deadline 才报超时。
      const tLive = Date.now()
      while (Date.now() - tLive < 20000) {
        if ((await readFileText(h.pidPath)) !== null) break
        if ((await readFileText(h.exitPath)) !== null) break
        await sleep(2000)
      }
      if ((await readFileText(h.pidPath)) === null && (await readFileText(h.exitPath)) === null) {
        throw new Error('分离进程未存活（20s 内没写出 pid.txt）：点火成功但子进程被回收/未能启动。' +
          '日志目录 ' + dir + '；launch-error=' + ((await readFileText(launchErrPath)) || '(无)'))
      }
      return h
    }

    // 轮询等待分离进程写出 exit.txt；超时则杀掉并标记 timedOut
    async function waitDetached(h, deadlineMs) {
      const t0 = Date.now()
      while (true) {
        const exitTxt = await readFileText(h.exitPath)
        if (exitTxt !== null) {
          const code = parseInt(String(exitTxt).trim(), 10)
          return {
            exitCode: isNaN(code) ? 1 : code,
            stdout: { text: (await readFileText(h.stdoutPath)) || '' },
            stderr: { text: (await readFileText(h.stderrPath)) || '' },
            timedOut: false,
            detachedDir: h.dir,
          }
        }
        if (Date.now() - t0 > deadlineMs) {
          try {
            const pid = parseInt(String(await readFileText(h.pidPath) || '').trim(), 10)
            if (!isNaN(pid)) {
              await shell.run(shell.resolve({
                command: 'Stop-Process -Id ' + pid + ' -Force -ErrorAction SilentlyContinue',
                timeoutMs: 20000,
                sandboxPolicy: { mode: 'workspace-write', workspaceRoot: COUNCIL_DIR },
              }))
            }
          } catch (e) { /* 杀不掉就算了，下面照样报超时 */ }
          return {
            exitCode: 1,
            stdout: { text: (await readFileText(h.stdoutPath)) || '' },
            stderr: { text: '分离进程轮询超时（deadlineMs=' + deadlineMs + '）' },
            timedOut: true,
            detachedDir: h.dir,
          }
        }
        await sleep(5000)
      }
    }

    // 与 shell.run(spec) 同形（exitCode/stdout/stderr/timedOut），但不受 600s 钳制。
    // 超时抛错；非零退出码原样返回，由调用方按语义分支（runPyChecked 的既有契约）。
    async function runLongChecked(command, workdir, timeoutMs, label) {
      const h = await spawnDetached(command, workdir)
      const res = await waitDetached(h, timeoutMs)
      if (res.timedOut) {
        throw new Error(label + ' 执行超时（分离进程轮询 deadline=' + timeoutMs +
          'ms；日志 ' + h.dir + '）')
      }
      return res
    }

    // ---- 工具：run_council ----
    ctx.effect(function () {
      return ctx.tools.register(defineTool({
        name: 'run_council',
        description: '运行 Model Council 多模型收敛评审：按模型能力动态调度（model@thinking 粒度）、交叉执行/交叉验证、逐轮收敛。task 为要评审的任务/决策；tier 为 fast（日常低风险 ¥0.03）/ standard（重要默认 ¥0.15）/ deep（高风险不可逆 ¥0.35）；mode 为 report（完整报告+审计，重大决策用）或 inline（结论直接作为回复内容，对话内联 30-60 秒）。设计新插件/新功能、重要架构决策、高风险操作前、花钱或不可逆决策时应主动调用。',
        parameters: {
          task: { type: 'string', description: '要评审的任务/决策描述。' },
          tier: { type: 'string', description: '档位：fast/standard/deep，默认 standard。' },
          mode: { type: 'string', description: '输出模式：report（完整报告）/ inline（结论即回复），默认 report。' },
        },
        output: {
          schema: { type: 'json' },
          render: function (args, value) { return [{ type: 'text', text: value.text || JSON.stringify(value, null, 2) }] },
        },
        async execute(args) {
          const task = String(args.task || '').trim()
          if (!task) throw new Error('task 不能为空')
          const tier = ['fast', 'standard', 'deep'].includes(args.tier) ? args.tier : 'standard'
          const mode = args.mode === 'inline' ? 'inline' : 'report'
          // v15.12：timeoutMs 现在只是**轮询 deadline**，不再是 shell 调用超时——
          // 因此不受 dsh-pwsh-local 的 maxTimeoutMs(600s) 钳制。python 自身有墙钟预算
          // 自限（wallBudget + 综合落盘），这里留足余量。report/inline 走的是同一个
          // 收敛循环、耗时相同，所以两者用同一 deadline（旧的 inline=300s 是错的）。
          const timeoutMs = 2700000
          const runRes = await runLongChecked(
            py('council_v14.py', '--task', task, '--tier', tier, '--mode', mode),
            COUNCIL_DIR, timeoutMs, 'council python')
          assertExitOk(runRes, 'council python')
          // 读最新 run 的 result.json（不依赖 shell 返回结构）
          // 注意：目录名混用两种格式（20260506-192100 / 2026-08-24_02-01-00），
          // 字符串排序会把 20260506 排在 2026-08-24 前面 → 必须按 mtime 排序。
          const runsDir = join(COUNCIL_DIR, 'runs')
          let latest = null
          try {
            const ordered = await recentRunDirs(runsDir)
            for (const d of ordered) {
              const r = await readJson(join(runsDir, d, 'result.json'))
              if (r) { latest = { run: d, result: r }; break }
            }
          } catch (e) { /* ignore */ }
          if (!latest) throw new Error('council 运行完成但未找到 result.json（可能失败，检查 ' + COUNCIL_DIR + '\\runs\\）')
          const res = latest.result
          const lines = []
          // v15.7（2026-09-13）：抬头只留档位/轮数/状态。S_r 轨迹是过程量，
          // 对读者无用（运行信息由 council_v14 追加到 report.md 末尾）。
          lines.push('【Council ' + tier + ' 档】状态：' + res.status + ' · 轮数：' + res.rounds)
          if (mode === 'inline' && res.inline_text) {
            lines.push('')
            lines.push(res.inline_text)
          } else {
            let report = ''
            try { report = await readFile(res.report, 'utf8') } catch (e) { /* ignore */ }
            lines.push('')
            lines.push('报告路径：' + res.report)
            if (report) lines.push('--- 报告 ---\n' + report)
          }
          return { text: lines.join('\n'), run: latest.run, result: res }
        },
      }))
    })

    // ---- 工具：council_status ----
    ctx.effect(function () {
      return ctx.tools.register(defineTool({
        name: 'council_status',
        description: '查看 Model Council 当前状态：能力档案概览（各模型各维度分数）、最近 runs 摘要、余额/额度快照、汇率。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: function (args, value) { return [{ type: 'text', text: value.text || JSON.stringify(value, null, 2) }] },
        },
        async execute() {
          const caps = await readJson(join(COUNCIL_DIR, 'capabilities.json'))
          const bal = await fetchBalance(false)
          const fx = await readJson(join(COUNCIL_DIR, 'exchange-rates.json'))
          const staleness = await computeStaleness()
          const drift = await readJson(join(COUNCIL_DIR, 'cost-drift.json'))
          const hits = await guardrailHits24h()
          const fbSize = await countLines(join(COUNCIL_DIR, 'evals', 'runtime-feedback.jsonl'))
          const lines = []
          const revision = caps && caps.revision != null ? caps.revision : 0
          if (caps && caps.models) {
            lines.push('【能力档案】' + Object.keys(caps.models).length + ' 个候选条目（revision ' + revision + '）')
            for (const [cid, m] of Object.entries(caps.models)) {
              const dims = Object.entries(m.capabilities || {})
                .filter(function (e) { return e[1] && e[1].score != null })
                .sort(function (a, b) { return b[1].score - a[1].score })
                .slice(0, 3)
                .map(function (e) { return e[0] + ':' + e[1].score })
                .join(' ')
              lines.push('  ' + cid + ' · ' + dims)
            }
          } else {
            lines.push('【能力档案】尚未生成（基准跑完后生成）')
          }
          if (bal.ok) {
            const b = bal.ok
            const parts = []
            if (b['deepseek-official:balance'] != null) parts.push('DeepSeek ¥' + Number(b['deepseek-official:balance']).toFixed(2))
            if (b['minimax-cn:5h'] != null) parts.push('MiniMax 5h窗口剩余 ' + b['minimax-cn:5h'] + '%')
            if (b['minimax-cn:week'] != null) parts.push('周窗口剩余 ' + b['minimax-cn:week'] + '%')
            lines.push('【余额/额度（实时，60s 缓存）】' + parts.join(' · '))
          }
          if (fx) lines.push('【汇率】USD/CNY ' + fx.usdToCny + '（' + fx.publishDate + (fx.stale ? '，已过期' : '') + '）')
          // M2：陈旧数据语义（staleReasons）
          if (staleness.quota_snapshot.stale) lines.push('⚠ 配额快照过期：' + staleness.quota_snapshot.reasons.join('; '))
          if (staleness.fx_rate.stale) lines.push('⚠ 汇率过期：' + staleness.fx_rate.reasons.join('; '))
          if (staleness.capabilities.stale) lines.push('⚠ 能力档案 7 天未更新（reasons: ' + staleness.capabilities.reasons.join('; ') + '）')
          // H3：成本对账
          if (drift && drift.driftPct != null) {
            lines.push('【成本对账】7 日 drift ' + drift.driftPct + '%（est ¥' + drift.estCny + ' vs actual ¥' + drift.actualCny + '，' + drift.runs + ' 个 run）')
          }
          // H4：护栏事件
          if (hits.total > 0) lines.push('【护栏】24h 触发 ' + hits.total + ' 次：' + JSON.stringify(hits.byGuard))
          if (fbSize > 0) lines.push('【反馈环】runtime-feedback ' + fbSize + ' 条')
          return { text: lines.join('\n'), revision: revision, caps: caps && Object.keys(caps.models || {}).length, balance: bal.ok, fx: fx, staleness: staleness, costDrift: drift, guardrailHits24h: hits, feedbackRingSize: fbSize }
        },
      }))
    })

    // ---- 工具：council_daily_job（定时任务 4 件套分发，命令对照 docs/operations.md §1 日常运维链） ----
    // job=fx → fetch_exchange_rate；auto_evolve → 换题检测（熔断暂停直接跳过，不许强跑）；
    // reconcile → cost_calibrate --check（退出 2=漂移告警，非失败）；
    // nightly → judge_drift → update_capabilities --apply → golden_evolve --fill-one（手册 && 语义）。
    // 约定：只有真正的执行错误才 throw（任务失败→重试→阻塞升级）；
    // 熔断暂停/无内容空转/漂移告警/额度用尽一律返回 ok 文本说明，不触发失败路径。
    // 唯一例外（已确认）：--apply 被门禁拒绝且原因需人工（baseHash_mismatch/malformed）→ throw 走阻塞升级。
    // python -m 模块模式（包内相对 import 需要包上下文）+ 工作目录锁定 council 根。
    // 沙箱策略必须显式声明（2026-09-06 实测：不传 sandboxPolicy 时子进程写
    // ~/.dsh/council/*.tmp 报 PermissionError，读正常——默认解析走了受限策略，
    // 与调用会话的 danger-full-access 无关）。council python 只写自家数据目录，
    // 用最小权限 workspace-write + root=COUNCIL_DIR（允许该目录 + 系统临时区）。
    // 注意：不要在这里传自定义 env（同日实测 allowlist env 也会导致同类 EACCES）。
    // cwd=COUNCIL_DIR 保证 import 解析到正确拷贝；污染环境的
    // _editable_impl_model_council.pth 已删除，PYTHONPATH 为空。
    function pyModCmd(mod, args) {
      const argStr = (args && args.length)
        ? ' ' + args.map(function (a) { return psArg(a) }).join(' ')
        : ''
      return 'python -m ' + mod + argStr
    }
    function shellTail(res, n) {
      const t = ((res && res.stdout && res.stdout.text) || '').trim()
      if (!t) return ''
      return t.split('\n').slice(-(n || 12)).join('\n')
    }
    // 2026-09-06 诊断教训：python 崩溃的 traceback 全在 stderr，只看 stdout 尾部
    // 会得到“退出码 1 + 空尾部”的不可诊断错误。失败抛错必须带 stderr 尾部。
    function shellErrTail(res, n) {
      const t = ((res && res.stderr && res.stderr.text) || '').trim()
      if (!t) return ''
      return t.split('\n').slice(-(n || 12)).join('\n')
    }
    function exitDetail(res) {
      const bits = []
      const so = shellTail(res)
      const se = shellErrTail(res)
      if (so) bits.push('stdout 尾部：\n' + so)
      if (se) bits.push('stderr 尾部：\n' + se)
      return bits.length ? '；' + bits.join('\n') : ''
    }
    function tryParseJsonTail(text) {
      const t = String(text || '').trim()
      if (!t) return null
      try { return JSON.parse(t) } catch (e) {
        try {
          const m = t.match(/\{[\s\S]*\}\s*$/)
          return m ? JSON.parse(m[0]) : null
        } catch (e2) { return null }
      }
    }
    async function runPyChecked(mod, args, timeoutMs) {
      // runShellChecked 的变体：超时/基础设施失败照样 throw，
      // 非零退出码则原样返回，由调用方按手册语义分支（退出 2 等）
      // v15.12：改走分离启动 + 轮询——judge_drift(1560s)/auto_evolve(1700s) 这两个
      // 夜间链任务原本会被 dsh-pwsh-local 的 maxTimeoutMs(600s) 静默钳死。
      return await runLongChecked(pyModCmd(mod, args), COUNCIL_DIR, timeoutMs,
                                  'council_daily_job ' + mod)
    }
    async function jobFx() {
      const res = await runPyChecked('orchestrator.fetch_exchange_rate', [], 180000)
      if (res.exitCode !== 0) {
        throw new Error('汇率抓取退出码 ' + res.exitCode + exitDetail(res))
      }
      const fx = await readJson(join(COUNCIL_DIR, 'exchange-rates.json'))
      if (!fx || fx.usdToCny == null) throw new Error('抓取成功但 exchange-rates.json 无有效汇率')
      return '汇率 OK：USD/CNY ' + fx.usdToCny + '（发布 ' + (fx.publishDate || '?') + (fx.stale ? '，已过期' : '') + '）'
    }
    async function jobAutoEvolve() {
      // 熔断预检：paused 直接跳过，不许强跑
      let st = null
      try { st = JSON.parse(await readFile(join(COUNCIL_DIR, 'auto-evolve-state.json'), 'utf8')) } catch (e) { st = null }
      if (st && st.paused) {
        return 'auto_evolve 已暂停：换题进化熔断中（pausedReason=' + (st.pausedReason || '?') + '，consecutiveFailures=' + (st.consecutiveFailures != null ? st.consecutiveFailures : '?') + '），按手册不强跑'
      }
      const res = await runPyChecked('benchmark.auto_evolve', [], 1700000)
      if (res.exitCode !== 0) {
        throw new Error('换题进化退出码 ' + res.exitCode + exitDetail(res))
      }
      const out = tryParseJsonTail(res.stdout && res.stdout.text)
      if (!out) return '换题进化完成（输出非 JSON，退出码 0）'
      if (out.paused) return 'auto_evolve 已暂停：换题进化熔断中（' + (out.reason || out.note || '?') + '）'
      if (out.action === 'noop') return '换题进化 noop：考卷无变化' + (out.note ? '（' + out.note + '）' : '')
      if (out.ok === false) throw new Error('换题进化失败：' + JSON.stringify(out).slice(0, 500))
      return '换题进化完成：action=' + (out.action || '?') + ' changed=' + JSON.stringify(out.changed != null ? out.changed : null)
    }
    async function jobReconcile() {
      const res = await runPyChecked('orchestrator.cost_calibrate', ['--check'], 180000)
      // 2026-09-10 沙箱兼容：workspace-write 下 python exit(2) 疑被上报为 1
      //（stdout 是完整告警 JSON 且无 stderr）。此时按 JSON 的 alerted 语义归一，
      // 避免“告警”被误判成“失败”进阻塞。真失败（traceback/非 JSON）照样抛错。
      if (res.exitCode !== 0 && res.exitCode !== 2) {
        const maybe = tryParseJsonTail(res.stdout && res.stdout.text)
        const se = shellErrTail(res)
        if (!(res.exitCode === 1 && maybe && maybe.alerted === true && !se)) {
          throw new Error('成本对账退出码 ' + res.exitCode + exitDetail(res))
        }
        res.exitCode = 2
      }
      let drift = null
      try { drift = JSON.parse(await readFile(join(COUNCIL_DIR, 'cost-drift.json'), 'utf8')) } catch (e) { drift = null }
      const driftTxt = drift && drift.driftPct != null
        ? ('7 日 drift ' + drift.driftPct + '%（est ¥' + drift.estCny + ' vs actual ¥' + drift.actualCny + '）')
        : 'drift 文件未读到，脚本尾部：' + shellTail(res, 5)
      if (res.exitCode === 2) return '成本对账告警（非失败）：' + driftTxt
      return '成本对账达标：' + driftTxt
    }
    function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64') }
    async function notifyDriftAlert(body) {
      // 漂移告警是“任务成功里的坏消息”：任务面板显示 done，不弹 toast 用户永远看不到。
      // 通知本身绝不能抛错（try/catch 就地吞），否则会把夜间链拖下水。
      try {
        const sp = ctx.get('sandboxPolicy')
        let policy
        if (sp !== undefined) {
          const base = sp.resolve()
          policy = { mode: 'danger-full-access', workspaceRoot: base.workspaceRoot }
        }
        const spec = shell.resolve({
          command: [
            '$ErrorActionPreference = "SilentlyContinue"',
            'Import-Module BurntToast',
            '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64('Council 漂移告警') + '"))',
            '$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64(body) + '"))',
            'New-BurntToastNotification -Text $t,$b',
          ].join('; '),
          timeoutMs: 8000,
          sandboxPolicy: policy,
        })
        await shell.run(spec)
      } catch (e) { /* 通知失败忽略 */ }
    }
    async function jobNightly() {
      const parts = []
      // 1) judge 漂移自评
      const jd = await runPyChecked('orchestrator.judge_drift', [], 1560000)
      const jdTail = shellTail(jd)
      if (jdTail.indexOf('QUOTA_EXHAUSTED') !== -1) {
        return '夜间链跳过：judge 额度用尽（QUOTA_EXHAUSTED），按手册全跳过不重试'
      }
      if (jd.exitCode !== 0 && jd.exitCode !== 2) {
        // 2026-09-10 沙箱兼容：同 jobReconcile，exit(2) 疑被上报为 1。
        // 仅当 stdout 是告警 JSON（alerted true）且无 stderr 时归一为 2；
        // 异常路径的 {"error":...} 照样抛错。
        const maybeJd = tryParseJsonTail(jd.stdout && jd.stdout.text)
        const seJd = shellErrTail(jd)
        if (!(jd.exitCode === 1 && maybeJd && maybeJd.alerted === true && !seJd)) {
          throw new Error('judge 漂移自评退出码 ' + jd.exitCode + (jdTail ? '；尾部：\n' + jdTail : ''))
        }
        jd.exitCode = 2
      }
      if (jd.exitCode === 2) {
        const stopMsg = '夜间链停止：judge 漂移告警（退出 2），按手册不断链跑 apply；尾部：' + jdTail.split('\n').slice(-3).join(' / ')
        await notifyDriftAlert(stopMsg)
        return stopMsg
      }
      parts.push('judge 自评干净')
      // 2) 体检通过自动 apply（退出码恒 0，看 JSON 的 applied/reason）
      const ap = await runPyChecked('orchestrator.update_capabilities', ['--apply'], 240000)
      if (ap.exitCode !== 0) {
        throw new Error('能力落盘退出码 ' + ap.exitCode + (shellTail(ap) ? '；尾部：\n' + shellTail(ap) : ''))
      }
      const apOut = tryParseJsonTail(ap.stdout && ap.stdout.text)
      if (!apOut) {
        parts.push('落盘输出非 JSON（退出 0），尾部：' + shellTail(ap, 3))
      } else if (apOut.applied) {
        parts.push('落盘成功 revision=' + apOut.revision + ' 改分 ' + apOut.changedScores + ' 项')
      } else if (apOut.reason === 'no_pending_diff') {
        parts.push('落盘空转：无待落盘内容')
      } else if (apOut.reason === 'judge_drift_pause_escalated') {
        // 连续暂停超上限：自进化已冻死多日，需人工重建基线（--init-baseline）。
        // 抛错走阻塞升级 + 先弹 toast（blocked 的上报是尽力而为，toast 保证可见）。
        const escMsg = '夜间链升级：judge 漂移连续暂停 ' + (apOut.pauseStreak || '?') + ' 次已升级，自进化冻结，需人工重建基线'
        await notifyDriftAlert(escMsg)
        throw new Error('能力落盘被门禁拒绝：' + apOut.reason + '（' + escMsg + '）')
      } else {
        // judge_drift_paused / baseHash_mismatch / pending_diff_malformed → 需人工，抛错走阻塞升级
        throw new Error('能力落盘被门禁拒绝：' + apOut.reason + '（需人工介入，已升级阻塞）')
      }
      // 3) 金标补一题（安全网拦截属正常，只记警告不抛错）
      const gd = await runPyChecked('benchmark.golden_evolve', ['--fill-one'], 660000)
      if (gd.exitCode !== 0) {
        parts.push('补题脚本退出码 ' + gd.exitCode + '（记警告，不算失败）：' + shellTail(gd, 3))
      } else {
        const gdOut = tryParseJsonTail(gd.stdout && gd.stdout.text)
        const fr = gdOut && (gdOut.fill || gdOut)
        const fst = fr && (fr.result || fr.status)
        if (fst && fst !== 'ok' && fst !== 'success') {
          parts.push('补题安全网拦截（属正常）：result=' + fst)
        } else {
          parts.push('补题完成：result=' + (fst || '?'))
        }
      }
      return '夜间链：' + parts.join('；')
    }
    ctx.effect(function () {
      return ctx.tools.register(defineTool({
        name: 'council_daily_job',
        description: 'Council 每日运维链分发（定时任务专用）：job=fx（汇率抓取）/auto_evolve（换题检测进化）/reconcile（成本对账）/nightly（judge自评→落盘→补题链）。只跑 operations.md 日常链规定的命令；熔断暂停/无内容空转/漂移告警/额度用尽返回说明不抛错，只有真正执行失败才抛错。',
        parameters: {
          job: { type: 'string', description: 'fx | auto_evolve | reconcile | nightly' },
        },
        output: {
          schema: { type: 'json' },
          render: function (args, value) { return [{ type: 'text', text: value.text || JSON.stringify(value, null, 2) }] },
        },
        async execute(args) {
          const job = String(args.job || '').trim()
          if (job === 'fx') return { text: await jobFx() }
          if (job === 'auto_evolve') return { text: await jobAutoEvolve() }
          if (job === 'reconcile') return { text: await jobReconcile() }
          if (job === 'nightly') return { text: await jobNightly() }
          throw new Error('未知 job：' + job + '（只支持 fx/auto_evolve/reconcile/nightly）')
        },
      }))
    })

    // ---- 余额/额度实时查询（60s 缓存，cost-monitor 同款端点；写回快照文件供 selector 用） ----
    let balCache = { at: 0, ok: {}, error: null }

    async function fetchBalance(force) {
      if (!force && balCache.ok && Object.keys(balCache.ok).length > 0 && Date.now() - balCache.at < 60000) return balCache
      const ok = {}
      let error = null
      try {
        const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
        const key = cred && cred.value
        if (!key) throw new Error('未找到 DEEPSEEK_API_KEY')
        const res = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        })
        const body = await res.json()
        const info = (body && body.balance_infos || []).find(function (b) { return b.currency === 'CNY' }) || (body && body.balance_infos || [])[0]
        if (!info) throw new Error('balance_infos 为空')
        ok['deepseek-official:balance'] = Number(info.total_balance) || 0
      } catch (e) { error = (error ? error + '; ' : '') + 'deepseek: ' + String(e && e.message ? e.message : e) }
      try {
        const cred = await ctx.credentials.resolve('MINIMAX_CN_API_KEY')
        const key = cred && cred.value
        if (!key) throw new Error('未找到 MINIMAX_CN_API_KEY')
        const res = await fetch('https://api.minimaxi.com/v1/token_plan/remains', {
          headers: { Authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(20000),
        })
        const body = await res.json()
        const general = (body && body.model_remains || []).find(function (b) { return b.model_name === 'general' })
        if (general) {
          // API 返回整数百分比（96 = 剩余 96%）；快照存原始值，展示层直接带 %，
          // selector（Python 侧 quota_factor）自行 /100 换算比例。
          const p5 = Number(general.current_interval_remaining_percent)
          const pw = Number(general.current_weekly_remaining_percent)
          if (Number.isFinite(p5)) ok['minimax-cn:5h'] = p5
          if (Number.isFinite(pw)) ok['minimax-cn:week'] = pw
        }
      } catch (e) { error = (error ? error + '; ' : '') + 'minimax: ' + String(e && e.message ? e.message : e) }
      balCache = { at: Date.now(), ok: ok, error: error }
      // 写回快照文件（供 selector/orchestrator 读取）
      try { await writeJsonAtomic(join(COUNCIL_DIR, 'balance-snapshot.json'), { ts: balCache.at, ok: balCache.ok, errors: error ? { host: error } : {} }) } catch (e) { /* ignore */ }
      return balCache
    }

    // ---- HTTP API（UI 数据） ----
    function sendJson(res, status, data) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    function readBody(req) {
      return new Promise(function (resolve, reject) {
        let data = ''
        req.on('data', function (c) { data += c })
        req.on('end', function () { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
        req.on('error', reject)
      })
    }

    async function recentRunDirs(runsDir, limit) {
      // 目录名两种格式混排，字符串排序不可靠 → 按 mtime 降序
      const dirs = (await readdir(runsDir, { withFileTypes: true }))
        .filter(function (d) { return d.isDirectory() })
        .map(function (d) { return d.name })
      const stats = await Promise.all(dirs.map(function (d) {
        return stat(join(runsDir, d)).then(function (s) { return s.mtimeMs }).catch(function () { return 0 })
      }))
      return dirs.map(function (d, i) { return { d: d, m: stats[i] } })
        .sort(function (a, b) { return b.m - a.m })
        .map(function (x) { return x.d })
        .slice(0, limit || 10000)
    }

    async function readLines(path) {
      try {
        return (await readFile(path, 'utf8')).split('\n').filter(function (l) { return l.trim() })
      } catch (e) { return [] }
    }

    async function countLines(path) {
      return (await readLines(path)).length
    }

    // M2：陈旧数据语义（quota_snapshot>90s / fx_rate>26h / capabilities>7d），stale_reasons: string[]
    async function computeStaleness() {
      const now = Date.now()
      const out = {
        quota_snapshot: { stale: false, ageSeconds: null, reasons: [] },
        fx_rate: { stale: false, ageHours: null, reasons: [] },
        capabilities: { stale: false, ageDays: null, reasons: [] },
      }
      try {
        const st = await stat(join(COUNCIL_DIR, 'balance-snapshot.json'))
        const age = (now - st.mtimeMs) / 1000
        out.quota_snapshot.ageSeconds = Math.round(age)
        if (age > 90) {
          out.quota_snapshot.stale = true
          out.quota_snapshot.reasons.push('quota_snapshot_age>90s')
        }
      } catch (e) {
        out.quota_snapshot.stale = true
        out.quota_snapshot.reasons.push('quota_snapshot_missing')
      }
      try {
        const fx = await readJson(join(COUNCIL_DIR, 'exchange-rates.json'))
        if (fx && fx.updatedAt) {
          const upd = Date.parse(fx.updatedAt)
          if (Number.isFinite(upd)) {
            const hours = (now - upd) / 3600000
            out.fx_rate.ageHours = Math.round(hours * 10) / 10
            if (hours > 26) {
              out.fx_rate.stale = true
              out.fx_rate.reasons.push('fx_rate_age>26h')
            }
          }
          if (Array.isArray(fx.staleReasons)) {
            out.fx_rate.reasons = out.fx_rate.reasons.concat(fx.staleReasons)
          }
          if (fx.stale) {
            out.fx_rate.stale = true
            if (out.fx_rate.reasons.length === 0) out.fx_rate.reasons.push('stale_flagged')
          }
        }
      } catch (e) {
        out.fx_rate.stale = true
        out.fx_rate.reasons.push('fx_rate_missing')
      }
      try {
        const caps = await readJson(join(COUNCIL_DIR, 'capabilities.json'))
        if (caps && caps.updatedAt) {
          const upd = Date.parse(caps.updatedAt)
          if (Number.isFinite(upd)) {
            const days = (now - upd) / 86400000
            out.capabilities.ageDays = Math.round(days * 10) / 10
            if (days > 7) {
              out.capabilities.stale = true
              out.capabilities.reasons.push('capabilities_not_ingested>7d')
            }
          }
        }
      } catch (e) {
        out.capabilities.stale = true
        out.capabilities.reasons.push('capabilities_missing')
      }
      return out
    }

    // H4：最近 24h 护栏触发（guardrail-events.jsonl，按 guard_name 聚合）
    async function guardrailHits24h() {
      const lines = await readLines(join(COUNCIL_DIR, 'guardrail-events.jsonl'))
      const cutoff = Date.now() - 24 * 3600 * 1000
      const byGuard = {}
      let total = 0
      for (const l of lines) {
        try {
          const e = JSON.parse(l)
          const ts = Date.parse(e.ts)
          if (!Number.isFinite(ts) || ts < cutoff) continue
          byGuard[e.guard_name] = (byGuard[e.guard_name] || 0) + 1
          total++
        } catch (e) { /* skip malformed */ }
      }
      return { total: total, byGuard: byGuard }
    }

    async function listRuns() {
      try {
        const runsDir = join(COUNCIL_DIR, 'runs')
        const ordered = await recentRunDirs(runsDir, 50)
        const out = []
        for (const d of ordered) {
          const r = await readJson(join(runsDir, d, 'result.json'))
          out.push({ run: d, result: r || null })
        }
        return out
      } catch (e) { return [] }
    }

    // ===== v15.6 L3 桥接端点（2026-09-05 从 2026-08-28 实现恢复；Python orchestrator 经此 HTTP 调任意 model） =====
    // DSH 内部走 pi-ai 处理 wire/auth/retry/协议差异；Python 只看到"调 LLM，拿到 text+usage"。
    // 在所有 configurable providers 里找 model id 对应的 provider；找不到则 404（不走流式）。
    // 注：listConfigurableProviders() 是同步函数，listModels(provider) 是 async。
    async function resolveLlmProvider(modelId) {
      let providers = []
      try { providers = ctx.llm.listConfigurableProviders() || [] } catch (e) { providers = [] }
      for (const prov of providers) {
        const pid = prov.provider || prov.id
        if (!pid) continue
        let models = []
        try { models = await ctx.llm.listModels(pid) } catch (e) { continue }
        if ((models || []).some(function (m) { return String(m.id || m.model || m.name) === String(modelId) })) {
          return { provider: pid, displayName: prov.displayName || pid }
        }
      }
      return null
    }
    // 把 pi-ai 的 LlmError / StreamChunk 翻译成 SSE event（写 head 后唯一可走的错误路径）
    function sseWrite(res, obj) {
      try {
        if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n')
      } catch (e) { /* 客户端已断，吞掉 */ }
    }
    async function handleLlmStream(req, res) {
      let body
      try { body = await readBody(req) }
      catch (e) { return sendJson(res, 400, { error: 'invalid json body: ' + String(e && e.message ? e.message : e) }) }

      const model = String(body.model || '').trim()
      const prompt = String(body.prompt || '')
      const level = body.level ? String(body.level) : undefined
      const maxTokens = Number(body.max_tokens) || 4096
      const system = body.system ? String(body.system) : undefined
      const temperature = body.temperature != null ? Number(body.temperature) : 0
      // v15.9：透传桥接会话 ID → ctx.llm.stream 的 sessionId → pi-ai 原生
      // session 头（openai-responses 适配器发 session_id/x-client-request-id +
      // prompt_cache_key）。OpenCode Zen 要求每会话稳定 session（缺则免费档
      // 400 MissingSessionID）；主会话经 agent-loop 自带 DSH session id，
      // council 经桥调用此前从不带，muse 全挂。Python 侧每进程一个稳定 id。
      const sessionId = body.session_id ? String(body.session_id)
        : (body.sessionId ? String(body.sessionId) : undefined)

      // v15.6：支持 messages 多轮调用（tool-use case）。prompt 和 messages 至少要有一个
      const hasMessages = Array.isArray(body.messages) && body.messages.length > 0
      if (!model || (!prompt && !hasMessages)) {
        return sendJson(res, 400, { error: 'model and (prompt or messages) are required', code: 'BAD_REQUEST' })
      }

      // 找 model 对应的 provider
      let resolved
      try { resolved = await resolveLlmProvider(model) }
      catch (e) { return sendJson(res, 502, { error: 'provider resolution failed: ' + String(e && e.message ? e.message : e), code: 'PROVIDER_RESOLVE_FAILED', model: model }) }
      if (!resolved) return sendJson(res, 404, { error: 'model not found in any configurable provider', code: 'MODEL_NOT_FOUND', model: model })

      const provider = resolved.provider

      // 提前校验能力（reasoningEffort）— 错误可以在写 head 前返回
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model)
        if (level && info && info.reasoning && Array.isArray(info.reasoning.efforts)) {
          const supported = info.reasoning.efforts.map(function (e) { return String(e.id) })
          if (supported.length > 0 && supported.indexOf(level) < 0) {
            return sendJson(res, 400, {
              error: 'unsupported reasoning level: ' + level + ' (supported: ' + supported.join(', ') + ')',
              code: 'UNSUPPORTED_REASONING_EFFORT',
              provider: provider, model: model,
            })
          }
        }
      } catch (e) { /* resolveModelInfo 失败不阻断（fail-soft） */ }

      // 写 SSE 头
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        })
      } catch (e) {
        return sendJson(res, 500, { error: 'failed to write SSE headers', code: 'WRITE_HEAD_FAILED' })
      }

      // AbortController — 客户端断开时取消 pi-ai 请求（避免资源泄漏）
      const ac = new AbortController()
      let clientClosed = false
      req.on('close', function () {
        if (!res.writableEnded) {
          clientClosed = true
          ac.abort()
        }
      })

      // 构造 message list（支持 messages 多轮 + tools function calling；fallback 单 prompt 向后兼容）
      const rawMessages = Array.isArray(body.messages) ? body.messages : null
      const rawTools = Array.isArray(body.tools) ? body.tools : null
      let messageList
      try {
        if (rawMessages && rawMessages.length > 0) {
          messageList = rawMessages.map(function (m) {
            const role = m && m.role
            if (role === 'tool') {
              // tool result message
              const resultText = typeof m.content === 'string' ? m.content
                : (Array.isArray(m.content) ? m.content.map(function (b) { return b && b.text || '' }).join('') : '')
              return createToolResultMessage({
                callId: m.tool_call_id || 'unknown',
                content: [{ type: 'text', text: resultText || '(no output)' }],
              })
            }
            if (role === 'assistant') {
              // assistant message（含可能的 tool_calls）
              const blocks = []
              if (m.content) {
                if (typeof m.content === 'string') blocks.push({ type: 'text', text: m.content })
                else if (Array.isArray(m.content)) {
                  for (const b of m.content) if (b && b.text) blocks.push({ type: 'text', text: b.text })
                }
              }
              if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                  const fn = (tc && tc.function) || tc
                  const name = fn && fn.name
                  if (!name) continue
                  blocks.push({
                    type: 'tool-call',
                    id: (tc && tc.id) || 'unknown',
                    name: name,
                    arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
                  })
                }
              }
              return createAssistantMessage({ content: blocks, source: { kind: 'model' } })
            }
            // user / system 消息
            let content
            if (typeof m.content === 'string') {
              content = [{ type: 'text', text: m.content }]
            } else if (Array.isArray(m.content)) {
              content = m.content
            } else {
              content = [{ type: 'text', text: String(m.content || '') }]
            }
            return createUserMessage({ content: content, source: { kind: 'user' } })
          })
        } else {
          // 向后兼容：单条 user message（v15.5 时代的调用方）
          messageList = [createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          })]
        }
      } catch (e) {
        sseWrite(res, { event: 'error', code: 'MESSAGE_BUILD_FAILED', message: String(e && e.message ? e.message : e) })
        sseWrite(res, '[DONE]')
        if (!res.writableEnded) res.end()
        return
      }

      // tools 翻译：把 OpenAI-compatible tools 数组转 dsh-llm tools schema
      let dshTools
      if (rawTools && rawTools.length > 0) {
        dshTools = rawTools.map(function (t) {
          const fn = (t && t.function) || t
          return {
            name: fn && fn.name,
            description: fn && fn.description,
            parameters: fn && fn.parameters,
          }
        }).filter(function (t) { return t && t.name })
      }

      const opts = {
        provider: provider,
        model: model,
        messages: messageList,
        temperature: temperature,
        signal: ac.signal,
        maxTokens: maxTokens,
      }
      if (level) opts.reasoningEffort = level
      if (system) opts.system = system
      if (sessionId) opts.sessionId = sessionId
      if (dshTools && dshTools.length > 0) opts.tools = dshTools

      try {
        const stream = ctx.llm.stream(opts)
        // 累积 tool-call 块（block-end 透传完整 tool call），
        // finish 时一次性发出 tool_calls 事件，让 Python 端知道该循环执行 tool 了。
        const pendingToolCalls = []
        for await (const chunk of stream) {
          if (clientClosed) break
          switch (chunk.type) {
            case 'text-delta':
              sseWrite(res, { event: 'text', delta: chunk.text })
              break
            case 'reasoning-delta':
              sseWrite(res, { event: 'reasoning', delta: chunk.text })
              break
            case 'usage':
              sseWrite(res, { event: 'usage', usage: chunk.usage })
              break
            case 'block-end':
              // v15.6 tool-use case 改造：捕获完整 tool call 块（含 id/name/arguments）
              if (chunk.block && chunk.block.type === 'tool-call') {
                pendingToolCalls.push({
                  id: chunk.block.id,
                  name: chunk.block.name,
                  arguments: chunk.block.arguments,
                })
              }
              break
            case 'finish':
              // 先发累积的 tool_calls（让 Python 端知道这一轮需要执行 tool），再发 finish。
              // 本轮无 tool call 时跳过。
              if (pendingToolCalls.length > 0) {
                sseWrite(res, { event: 'tool_calls', calls: pendingToolCalls })
              }
              sseWrite(res, { event: 'finish', reason: chunk.reason })
              break
            case 'tool-call-delta':
              // dsh-llm 在 streaming tool-call 时也会发 delta chunk，但完整 args
              // 在 block-end 时才能拿到；这里只占位（不重复发，依赖 block-end）
              break
            default:
              // 忽略未知 chunk 类型
              break
          }
        }
        sseWrite(res, '[DONE]')
        if (!res.writableEnded) res.end()
      } catch (e) {
        // 写 head 之后唯一可走的错误路径：SSE error event + [DONE]
        const code = (e && e.code) || 'STREAM_ERROR'
        sseWrite(res, {
          event: 'error',
          code: String(code),
          message: String(e && e.message ? e.message : e),
          provider: provider,
          model: model,
        })
        sseWrite(res, '[DONE]')
        if (!res.writableEnded) res.end()
      }
    }

    // v15.10 tool-exec：宿主只读工具执行（council tool loop 用）。
    // 只放行 web_search/web_fetch（双边 allowlist，Python 侧同样校验），
    // 经宿主 ctx.web 执行（与主会话同后端同 key，只读、无审批门）。
    // ctx.get('web') 软拿：组合里没挂 web 服务时报 503，不炸插件树。
    const TOOL_EXEC_ALLOW = { web_search: true, web_fetch: true }
    function formatSearchResult(r) {
      const lines = []
      if (r && r.content) lines.push('提供方答案：' + String(r.content).slice(0, 2000))
      const sources = (r && r.sources) || []
      sources.forEach(function (s, i) {
        const title = (s && (s.title || s.url)) || ('来源' + (i + 1))
        lines.push('- [' + title + '](' + ((s && s.url) || '') + ')' +
          (s && s.snippet ? ' —— ' + String(s.snippet).slice(0, 600) : '') +
          (s && s.publishedAt ? '（' + s.publishedAt.slice(0, 10) + '）' : ''))
      })
      if (r && r.truncated) lines.push('（来源列表被截断）')
      return lines.join('\n') || '(无结果)'
    }
    function formatFetchResult(r) {
      if (!r) return '(抓取无结果)'
      const body = (r.body && r.body.content) || ''
      return '最终URL：' + (r.url || '') + '\n状态码：' + (r.statusCode || '') +
        (r.truncated ? '（正文被截断）' : '') + '\n正文：\n' + String(body).slice(0, 12000)
    }
    async function handleToolExec(req, res) {
      let body
      try { body = await readBody(req) }
      catch (e) { return sendJson(res, 400, { ok: false, error: 'invalid json body' }) }
      const name = String((body && body.name) || '')
      const args = (body && body.args && typeof body.args === 'object') ? body.args : {}
      if (!TOOL_EXEC_ALLOW[name]) {
        return sendJson(res, 403, { ok: false, error: 'tool not allowed: ' + (name || '(empty)') })
      }
      const web = ctx.get ? ctx.get('web') : undefined
      if (!web) {
        return sendJson(res, 503, { ok: false, error: 'web service unavailable' })
      }
      try {
        if (name === 'web_search') {
          const queries = Array.isArray(args.queries)
            ? args.queries.map(function (q) { return String(q || '').trim() }).filter(Boolean).slice(0, 4)
            : []
          if (queries.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'web_search requires queries[1..4]' })
          }
          const maxResults = Math.max(1, Math.min(8, Number(args.maxResults) || 5))
          const parts = []
          for (const q of queries) {
            const sig = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
              ? AbortSignal.timeout(45000) : undefined
            const r = await web.search({ query: q, maxResults: maxResults }, sig)
            parts.push('### 查询：' + q + '\n' + formatSearchResult(r))
          }
          return sendJson(res, 200, { ok: true, result: parts.join('\n\n').slice(0, 24000) })
        }
        const url = String(args.url || '')
        if (!/^https?:\/\//i.test(url)) {
          return sendJson(res, 400, { ok: false, error: 'web_fetch requires http(s) url' })
        }
        const sig = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
          ? AbortSignal.timeout(45000) : undefined
        const r = await web.fetch({ url: url }, sig)
        return sendJson(res, 200, { ok: true, result: formatFetchResult(r).slice(0, 24000) })
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: 'tool-exec failed: ' + String((e && e.message) || e).slice(0, 300) })
      }
    }

    async function handleRequest(req, res) {
      try {
        const url = new URL(req.url || '/', 'http://x')
        const op = url.pathname.slice('/api/council'.length).replace(/^\/+/, '')
        const method = req.method || 'GET'

        if (method === 'POST' && op === 'llm-stream') {
          return handleLlmStream(req, res)
        }

        // v15.10：宿主工具执行（council tool loop 用）。只放行只读的
        // web_search/web_fetch，经宿主 ctx.web 执行（与主会话同后端同 key，
        // 只读、无审批门）。Python 侧同样有 allowlist，双边校验。
        if (method === 'POST' && op === 'tool-exec') {
          return handleToolExec(req, res)
        }

        if (method === 'GET' && op === 'ds-models') {
          // DSH 已配置模型一览（控制台“增加模型”下拉数据源）。
          // 每项带 thinkings：该模型在 DSH 配置里实际支持的档位（resolveModelInfo 的
          // reasoning.efforts）；拿不到的省略，客户端回退内置映射表。
          const out = []
          let providers = []
          try { providers = ctx.llm.listConfigurableProviders() || [] } catch (e) { providers = [] }
          for (const prov of providers) {
            const pid = prov.provider || prov.id
            if (!pid) continue
            let models = []
            try { models = await ctx.llm.listModels(pid) } catch (e) { continue }
            for (const m of models || []) {
              const id = m && String(m.id || m.model || m.name || '')
              if (!id) continue
              const entry = { id: id, provider: pid }
              try {
                const info = await ctx.llm.resolveModelInfo(pid, id)
                const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
                  ? info.reasoning.efforts.map(function (e) { return String((e && e.id) || e) }).filter(Boolean)
                  : []
                if (efforts.length > 0) entry.thinkings = efforts
              } catch (e) { /* 拿不到就省略，客户端回退 */ }
              out.push(entry)
            }
          }
          return sendJson(res, 200, { models: out })
        }

        if (method === 'GET' && (op === 'state' || op === '')) {
          const freshBal = await fetchBalance(false)
          const [caps, pricing, fx, runs, circuit, drift, staleness, hits, fbSize, jd] = await Promise.all([
            readJson(join(COUNCIL_DIR, 'capabilities.json')),
            readJson(join(COUNCIL_DIR, 'pricing-profiles.json')),
            readJson(join(COUNCIL_DIR, 'exchange-rates.json')),
            listRuns(),
            readJson(join(COUNCIL_DIR, 'circuit-state.json')),
            readJson(join(COUNCIL_DIR, 'cost-drift.json')),
            computeStaleness(),
            guardrailHits24h(),
            countLines(join(COUNCIL_DIR, 'evals', 'runtime-feedback.jsonl')),
            readJson(join(COUNCIL_DIR, 'judge-drift.json')),
          ])
          return sendJson(res, 200, {
            caps, pricing, fx, runs, circuit,
            balance: { ok: freshBal.ok, error: freshBal.error, at: freshBal.at },
            revision: caps && caps.revision != null ? caps.revision : 0,
            staleness: staleness,
            costDrift: drift,
            guardrailHits24h: hits,
            feedbackRingSize: fbSize,
            judgeDrift: jd,
          })
        }

        const body = await readBody(req)

        if (method === 'POST' && op === 'settings') {
          // UI 写回：支持 capabilities / pricing-profiles / 参数
          const changed = []
          if (body.capabilities) {
            await writeJsonAtomic(join(COUNCIL_DIR, 'capabilities.json'), body.capabilities)
            changed.push('capabilities')
          }
          if (body.pricing) {
            await writeJsonAtomic(join(COUNCIL_DIR, 'pricing-profiles.json'), body.pricing)
            changed.push('pricing')
          }
          return sendJson(res, 200, { ok: true, changed })
        }

        if (method === 'POST' && op === 'run') {
          const task = String(body.task || '').trim()
          const tier = ['fast', 'standard', 'deep'].includes(body.tier) ? body.tier : 'standard'
          const mode = body.mode === 'inline' ? 'inline' : 'report'
          if (!task) return sendJson(res, 400, { error: 'task required' })
          try {
            // v15.12：同 run_council 工具——走分离启动 + 轮询，绕开 600s 钳制
            const hcmd = py('council_v14.py', '--task', task, '--tier', tier, '--mode', mode)
            const hres = await runLongChecked(hcmd, COUNCIL_DIR, 2700000, 'council python')
            assertExitOk(hres, 'council python')
            return sendJson(res, 200, { ok: true })
          } catch (e) {
            return sendJson(res, 500, { error: String(e && e.message ? e.message : e) })
          }
        }

        sendJson(res, 404, { error: 'unknown-op' })
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message ? e.message : e) })
      }
    }

    ctx.effect(function () {
      return ctx.webServer.register({ kind: 'prefix', path: '/api/council', handler: handleRequest })
    })

    // ---- Prometheus 指标（M1）：/metrics 文本格式 ----
    // capability_revision_total / cost_drift_pct / guardrail_hits_total{guard}
    // feedback_ring_size / cfets_stale_minutes
    async function metricsHandler(req, res) {
      try {
        const [caps, fx, drift, hits, fbSize] = await Promise.all([
          readJson(join(COUNCIL_DIR, 'capabilities.json')),
          readJson(join(COUNCIL_DIR, 'exchange-rates.json')),
          readJson(join(COUNCIL_DIR, 'cost-drift.json')),
          guardrailHits24h(),
          countLines(join(COUNCIL_DIR, 'evals', 'runtime-feedback.jsonl')),
        ])
        const revision = caps && caps.revision != null ? caps.revision : 0
        const driftPct = drift && drift.driftPct != null ? drift.driftPct : NaN
        let cfetsStaleMinutes = 0
        if (fx && fx.stale && fx.updatedAt) {
          const age = (Date.now() - Date.parse(fx.updatedAt)) / 60000
          if (Number.isFinite(age) && age > 0) cfetsStaleMinutes = Math.round(age)
        }
        const out = []
        out.push('# HELP dsh_council_capability_revision_total 能力档案 revision（自进化写入计数，单调递增）。')
        out.push('# TYPE dsh_council_capability_revision_total gauge')
        out.push('dsh_council_capability_revision_total ' + revision)
        out.push('# HELP dsh_council_cost_drift_pct 7 日估算 vs 实际成本偏差百分比（<2 为校准达标）。')
        out.push('# TYPE dsh_council_cost_drift_pct gauge')
        out.push('dsh_council_cost_drift_pct ' + (Number.isFinite(driftPct) ? driftPct : 'NaN'))
        out.push('# HELP dsh_council_guardrail_hits_total 最近 24h 护栏触发次数（guard 标签，滑动窗口）。')
        out.push('# TYPE dsh_council_guardrail_hits_total gauge')
        for (const g of Object.keys(hits.byGuard || {})) {
          out.push('dsh_council_guardrail_hits_total{guard="' + g + '"} ' + hits.byGuard[g])
        }
        out.push('# HELP dsh_council_feedback_ring_size feedback_ring（runtime-feedback.jsonl）条数。')
        out.push('# TYPE dsh_council_feedback_ring_size gauge')
        out.push('dsh_council_feedback_ring_size ' + fbSize)
        out.push('# HELP dsh_council_cfets_stale_minutes 汇率距最近一次更新的分钟数（stale 时>0）。')
        out.push('# TYPE dsh_council_cfets_stale_minutes gauge')
        out.push('dsh_council_cfets_stale_minutes ' + cfetsStaleMinutes)
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(out.join('\n') + '\n')
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message ? e.message : e) })
      }
    }
    ctx.effect(function () {
      try {
        return ctx.webServer.register({ kind: 'prefix', path: '/metrics', handler: metricsHandler })
      } catch (e) {
        try { console.warn('[council] /metrics 已被占用，跳过注册:', String(e && e.message ? e.message : e)) } catch (e2) { /* ignore */ }
      }
    })

    // ---- 汇率每日 09:30 定时更新（CFETS，北京时间） ----
    // 注意：toISOString() 是 UTC 时刻，北京 9:30-17:29 的 UTC 时刻恒 < 09:30，
    // 用 UTC 判断会只在下午 17:30 后才触发。这里按 UTC+8 显式换算。
    let lastFxDate = ''
    function beijingNow() {
      const d = new Date(Date.now() + 8 * 3600 * 1000)
      return { dateStr: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) }
    }
    async function maybeUpdateFx() {
      try {
        const bj = beijingNow()
        if (bj.hm >= '09:30' && bj.dateStr !== lastFxDate) {
          // v15.12（2026-09-13 修）：补 sandboxPolicy——与 run_council 同一类漏洞。
          // 此前这里不传策略 → 子进程走受限令牌 → 写 ~/.dsh/council/*.tmp 报 EACCES，
          // 又被下面的 catch 静默吞掉，所以汇率定时器长期「看起来没事」，实际靠
          // task-panel 的 council_daily_job job=fx 兜底。
          const spec = shell.resolve({ command: py('fetch_exchange_rate.py'), timeoutMs: 60000,
            sandboxPolicy: { mode: 'workspace-write', workspaceRoot: COUNCIL_DIR } })
          await runShellChecked(spec)   // 失败会 throw：不记日期，下一轮（60s 后）自动重试
          lastFxDate = bj.dateStr
        }
      } catch (e) { /* 汇率失败降级：沿用旧值（fetch_exchange_rate 内部已处理 stale） */ }
    }
    ctx.setInterval(maybeUpdateFx, 60 * 1000)
    maybeUpdateFx().catch(function () {})
  },
}
