# dsh-council（DSH 固化插件，前后端一体）

Model Council 在 DeepSeek Harness 里的一体化插件：宿主 half 提供工具与 HTTP API，
客户端 half 提供侧栏卡片与设置页控制台。Python 评审编排层不在这里，
在 [model-council](https://github.com/hbgangcn1/model-council) 仓库。

## 文件

| 文件 | 面 | 说明 |
|---|---|---|
| `index.js` | 宿主 | `run_council` / `council_status` / `council_daily_job` 工具；`/api/council/*`（state/settings/run）+ `/metrics`；`POST /api/council/llm-stream` 模型桥（Python 经此调任意 model，走 pi-ai）；汇率每日定时抓取 |
| `client.js` | 客户端 | 侧栏 Council 卡（汇率+最近 run）；设置页 5 标签控制台（总览/模型与能力/定价与成本/运行记录/自改进） |
| `package.json` | 声明 | `main` 宿主入口，`./client` 客户端 bundle，`dsh.client.platform=web` |

## 改动生效规则（血泪版，必读）

1. 改 `index.js` → **必须重启 DSH 进程**（Node ESM import 缓存），重启后确认新进程 CreationDate 晚于文件时间；
2. 改 `client.js` → **刷新页面（F5）即可**（`dsh-client-modules` 现读 + `?rev=` 内容哈希）；
3. **双份同步**：线上生效的是 `~/.dsh/profiles/web/node_modules/dsh-council/` 那份，
   workspace 与 profile 是**分离拷贝**（非硬链接），改完必须两边同步，否则下次 `pnpm remove+add` 重装会丢修复；
4. client 约束：`window.__ModuleLoader__.load({id, factory})` 注册，`exports.apply` 必备，
   用 `ctx.slots` 必须声明 `exports.inject = ["slots"]`（否则新版静默不渲染，见 2026-09-05 事故）；
   host 约束：所有直接 `ctx.XXX` 访问必须进 `inject` 数组（漏了整个插件树起不来，DSH 直接罢工）。

## 定时任务关联

`council_daily_job` 四档（命令对照 model-council 仓 `docs/operations.md §1`）：
`fx` 汇率抓取 / `auto_evolve` 换题进化（熔断暂停直接跳过）/
`reconcile` 成本对账（退出 2=告警非失败）/
`nightly` 自评→落盘→补题链（额度用尽全跳过；门禁拒绝且需人工则抛错升级阻塞）。

## 基线

- 2026-09-05：Council UI 复活（slots 硬依赖）+ `council_daily_job` 新增 + `llm-stream` 桥恢复（自 2026-08-28 实现回放），对应 DSH 0.1.2-rc.1。
