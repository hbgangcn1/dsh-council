window.__ModuleLoader__.load({
  id: "dsh-council",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")

    const CSS = `
.ccl-root { display:flex; flex-direction:column; gap:14px; padding:16px; }
.ccl-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:0; }
.ccl-tab { font-size:12.5px; padding:7px 12px; border:none; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; border-bottom:2px solid transparent; }
.ccl-tab:hover { color:var(--dsw-alias-label-primary); }
.ccl-tab.ccl-on { color:var(--dsw-alias-brand-primary); border-bottom-color:var(--dsw-alias-brand-primary); font-weight:600; }
.ccl-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.ccl-desc { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.ccl-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); padding:12px; display:flex; flex-direction:column; gap:8px; }
.ccl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; }
.ccl-kv { display:flex; justify-content:space-between; font-size:12px; gap:8px; }
.ccl-kv .k { color:var(--dsw-alias-label-secondary); }
.ccl-kv .v { color:var(--dsw-alias-label-primary); font-weight:600; text-align:right; }
.ccl-num { font-variant-numeric:tabular-nums; }
.ccl-table { width:100%; border-collapse:collapse; font-size:12px; }
.ccl-table th { text-align:left; color:var(--dsw-alias-label-secondary); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.ccl-table td { padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.ccl-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
.ccl-badge { display:inline-block; font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); }
.ccl-badge.ok { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.ccl-badge.warn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.ccl-badge.err { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.ccl-badge.brand { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.ccl-input { font-size:12px; padding:5px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); width:110px; font-variant-numeric:tabular-nums; }
.ccl-input:focus { border-color:var(--dsw-alias-brand-primary); outline:none; }
.ccl-btn { font-size:12px; padding:5px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; }
.ccl-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); }
.ccl-btn:disabled { opacity:.5; cursor:default; }
.ccl-btn.danger:hover:not(:disabled) { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.ccl-save { color:var(--dsw-alias-state-success-primary); font-size:12px; }
.ccl-err { padding:8px 10px; font-size:12px; color:var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-state-error-primary); border-radius:6px; }
.ccl-empty { padding:24px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.ccl-detail { font-size:12px; color:var(--dsw-alias-label-primary); white-space:pre-wrap; max-height:380px; overflow:auto; background:var(--dsw-alias-bg-layer-2); border-radius:6px; padding:10px; line-height:1.6; }
.ccl-svg { width:100%; height:auto; }
.ccl-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ccl-grow { flex:1; min-width:0; }
.ccl-hint { font-size:11px; color:var(--dsw-alias-label-secondary); }
`

    const tagId = "@deepseek-ai/dsh-council/ui.css"
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      const tag = document.createElement("style")
      tag.textContent = CSS
      tag.dataset.pluginCss = tagId
      document.head.appendChild(tag)
    }

    const DIMS = ["reasoning", "code", "chinese", "research", "instruction_following",
      "long_context", "tool_use", "creativity", "safety"]
    const DIM_LABEL = { reasoning: "推理", code: "代码", chinese: "中文", research: "研究",
      instruction_following: "指令遵循", long_context: "长上下文", tool_use: "工具使用",
      creativity: "创意", safety: "安全" }
    const STATUS_LABEL = { converged: "已收敛", rework: "返工中", early_stop: "边际早停",
      forced: "强制收敛", stalled: "停滞", decompose_failed: "分解失败",
      budget_precheck_over: "预算预检超限", ok_dry: "预检通过" }

    function statusLabel(s) {
      return STATUS_LABEL[s] || s || "--"
    }

    function fmt(n, digits) {
      if (n == null) return "--"
      const v = Number(n)
      return String(Math.round(v * Math.pow(10, digits || 1)) / Math.pow(10, digits || 1))
    }

    // ---------- SVG 图表（手绘，无依赖） ----------
    function RadarSvg(props) {
      const values = props.values || {}
      const labels = DIMS
      const cx = 110, cy = 100, r = 78
      const n = labels.length
      function pt(i, val) {
        const a = (Math.PI * 2 * i) / n - Math.PI / 2
        const rr = Math.max(0.08, Math.min(1, val / 10)) * r
        return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]
      }
      const grid = [2, 4, 6, 8, 10].map(function (v) {
        return labels.map(function (_, i) { return pt(i, v).join(",") }).join(" ")
      })
      const poly = labels.map(function (_, i) { return pt(i, values[labels[i]]) }).map(function (p) { return p.join(",") }).join(" ")
      return React.createElement("svg", { viewBox: "0 0 220 210", className: "ccl-svg", role: "img", "aria-label": props.title || "能力雷达图" },
        grid.map(function (g, i) {
          return React.createElement("polygon", { key: "g" + i, points: g, fill: "none",
            stroke: "var(--dsw-alias-border-l2)", strokeWidth: 0.6 })
        }),
        labels.map(function (_, i) {
          const p = pt(i, 10)
          return React.createElement("line", { key: "a" + i, x1: cx, y1: cy, x2: p[0], y2: p[1],
            stroke: "var(--dsw-alias-border-l2)", strokeWidth: 0.6 })
        }),
        React.createElement("polygon", { points: poly, fill: "var(--dsw-alias-brand-primary)", fillOpacity: 0.16,
          stroke: "var(--dsw-alias-brand-primary)", strokeWidth: 1.4 }),
        labels.map(function (label, i) {
          const p = pt(i, 10)
          const lx = cx + (r + 14) * Math.cos((Math.PI * 2 * i) / n - Math.PI / 2)
          const ly = cy + (r + 14) * Math.sin((Math.PI * 2 * i) / n - Math.PI / 2)
          return React.createElement("text", { key: "t" + i, x: lx, y: ly, fontSize: 8.5,
            textAnchor: "middle", dominantBaseline: "middle", fill: "var(--dsw-alias-label-secondary)" },
            DIM_LABEL[label])
        }))
    }

    function SparklineSvg(props) {
      const vals = props.values || []
      const w = 260, h = 44
      if (vals.length === 0) return React.createElement("div", { className: "ccl-empty" }, "暂无轮次数据")
      const max = Math.max.apply(null, vals.concat([10]))
      const pts = vals.map(function (v, i) {
        const x = vals.length === 1 ? w / 2 : 4 + (i * (w - 8)) / (vals.length - 1)
        const y = h - 6 - (v / max) * (h - 12)
        return [x, y]
      })
      return React.createElement("svg", { viewBox: "0 0 " + w + " " + h, className: "ccl-svg", role: "img", "aria-label": "收敛曲线" },
        React.createElement("polyline", { points: pts.map(function (p) { return p.join(",") }).join(" "),
          fill: "none", stroke: "var(--dsw-alias-brand-primary)", strokeWidth: 1.6 }),
        pts.map(function (p, i) {
          return React.createElement("circle", { key: i, cx: p[0], cy: p[1], r: 2.4, fill: "var(--dsw-alias-brand-primary)" })
        }),
        vals.map(function (v, i) {
          return React.createElement("text", { key: "t" + i, x: pts[i][0], y: pts[i][1] - 6, fontSize: 8,
            textAnchor: "middle", fill: "var(--dsw-alias-label-secondary)" }, fmt(v, 1))
        }))
    }

    // ---------- 数据加载 ----------
    function useCouncilState() {
      const [state, setState] = React.useState(null)
      const [err, setErr] = React.useState("")
      function load() {
        return fetch("/api/council/state")
          .then(function (r) { return r.json() })
          .then(function (d) { setState(d); setErr("") })
          .catch(function (e) { setErr("读取失败：" + String(e && e.message ? e.message : e)) })
      }
      React.useEffect(function () {
        load()
        const t = setInterval(load, 15000)
        return function () { clearInterval(t) }
      }, [])
      return { state: state, err: err, reload: load }
    }

    // ---------- Tab 1 总览 ----------
    function Dashboard(props) {
      const s = props.state || {}
      const bal = (s.balance && s.balance.ok) || {}
      const fx = s.fx || {}
      const jd = s.judgeDrift || {}
      const runs = s.runs || []
      const latest = runs.find(function (r) { return r && r.result }) || null
      const circuit = s.circuit || {}
      const openModels = Object.keys(circuit).filter(function (m) {
        return circuit[m] && (circuit[m].state === "open" || circuit[m].state === "half_open")
      })
      const models = s.caps && s.caps.models ? Object.keys(s.caps.models).length : 0
      return React.createElement("div", { className: "ccl-grid" },
        React.createElement("div", { className: "ccl-card" },
          React.createElement("div", { className: "ccl-title" }, "余额与额度"),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "DeepSeek 余额"),
            React.createElement("span", { className: "v ccl-num" }, bal["deepseek-official:balance"] != null ? "¥" + fmt(bal["deepseek-official:balance"], 2) : "--")),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "MiniMax 5h 窗口"),
            React.createElement("span", { className: "v ccl-num" }, bal["minimax-cn:5h"] != null ? fmt(bal["minimax-cn:5h"], 0) + "%" : "--")),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "USD/CNY 汇率"),
            React.createElement("span", { className: "v ccl-num" }, fx.usdToCny || "--")),
          React.createElement("div", { className: "ccl-hint" },
            "汇率发布 " + (fx.publishDate || "--") + (fx.stale ? "（已过期，待 9:30 更新）" : ""))),
        React.createElement("div", { className: "ccl-card" },
          React.createElement("div", { className: "ccl-title" }, "Judge 漂移"),
          jd.drift == null
            ? React.createElement("div", { className: "ccl-empty" }, "暂无自评数据")
            : React.createElement(React.Fragment, null,
              React.createElement("div", { className: "ccl-kv" },
                React.createElement("span", { className: "k" }, "状态"),
                React.createElement("span", { className: "ccl-badge " + (jd.alerted ? "warn" : "ok") },
                  jd.alerted ? "漂移告警" : "正常")),
              React.createElement("div", { className: "ccl-kv" },
                React.createElement("span", { className: "k" }, "总漂移"),
                React.createElement("span", { className: "v ccl-num" }, fmt(jd.drift, 2))),
              React.createElement("div", { className: "ccl-hint" },
                "自评 " + String(jd.generatedAt || "--").slice(0, 10)))),
        React.createElement("div", { className: "ccl-card" },
          React.createElement("div", { className: "ccl-title" }, "模型池"),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "候选条目（model@thinking）"),
            React.createElement("span", { className: "v ccl-num" }, models)),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "能力档案 revision"),
            React.createElement("span", { className: "v ccl-num" }, s.caps && s.caps.revision || 0)),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "运行期反馈 run 数"),
            React.createElement("span", { className: "v ccl-num" }, s.caps && s.caps.runtimeFeedback ? s.caps.runtimeFeedback.totalRuns : 0)),
          openModels.length > 0
            ? React.createElement("div", { className: "ccl-hint" }, "熔断中：" + openModels.join("、"))
            : React.createElement("div", { className: "ccl-hint" }, "无熔断模型")),
        React.createElement("div", { className: "ccl-card" },
          React.createElement("div", { className: "ccl-title" }, "最近一次 Council"),
          latest
            ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "ccl-kv" },
                React.createElement("span", { className: "k" }, "状态 / 轮数"),
                React.createElement("span", { className: "v" }, statusLabel(latest.result.status) + " · " + latest.result.rounds + " 轮")),
              React.createElement("div", { className: "ccl-kv" },
                React.createElement("span", { className: "k" }, "档位"),
                React.createElement("span", { className: "v" }, latest.result.tier || "--")),
              SparklineSvg({ values: latest.result.s_history || [] }))
            : React.createElement("div", { className: "ccl-empty" }, "还没有运行记录"),
        ),
      )
    }

    // ---------- Tab 2 模型与能力 ----------
    function ModelsTab(props) {
      const s = props.state || {}
      const models = s.caps && s.caps.models ? s.caps.models : {}
      const [sel, setSel] = React.useState(null)
      const [dsList, setDsList] = React.useState(null)
      const [addBase, setAddBase] = React.useState("")
      const [addMsg, setAddMsg] = React.useState("")
      const [confirmRemove, setConfirmRemove] = React.useState(false)
      // 各 provider 实际在用的 thinking 档位（按池中已有 18 条目归纳；未知 provider 回退全量六档）
      const THINKINGS_BY_PROVIDER = {
        "deepseek-official": ["off", "low", "high", "max"],
        "minimax-cn": ["off", "minimal", "low", "medium", "high"],
        "zai-coding-cn": ["minimal", "low", "medium", "high", "max"],
      }
      const ALL_THINKINGS = ["off", "minimal", "low", "medium", "high", "max"]
      const entries = Object.entries(models).sort(function (a, b) {
        return String(a[0]).localeCompare(String(b[0]))
      })
      const selModel = sel && models[sel] ? models[sel] : null
      function toggleStable(cid) {
        const next = JSON.parse(JSON.stringify(models))
        next[cid].stable = !(next[cid].stable !== false)
        save(next)
      }
      function save(nextCaps) {
        fetch("/api/council/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilities: Object.assign({}, s.caps, { models: nextCaps }) }),
        }).then(function (r) { return r.json() }).then(function () { props.reload() })
      }
      function loadDsModels() {
        setDsList(null)
        setAddMsg("")
        fetch("/api/council/ds-models")
          .then(function (r) { return r.json() })
          .then(function (d) { setDsList(d && d.models ? d.models : []) })
          .catch(function () { setDsList([]); setAddMsg("模型列表拉取失败") })
      }
      function baseInPool(base) {
        return Object.keys(models).some(function (k) { return k === base || k.indexOf(base + "__") === 0 })
      }
      function addModel() {
        if (!addBase) { setAddMsg("先选一个模型"); return }
        const found = (dsList || []).filter(function (m) { return m && m.id === addBase })[0]
        const provider = found ? found.provider : ""
        // 档位优先用桥返回的该模型实际配置（ds-models.thinkings），拿不到才回退内置映射表
        const levels = (found && Array.isArray(found.thinkings) && found.thinkings.length > 0)
          ? found.thinkings
          : (THINKINGS_BY_PROVIDER[provider] || ALL_THINKINGS)
        const next = JSON.parse(JSON.stringify(models))
        let added = 0
        for (const lv of levels) {
          const cid = addBase + "__" + lv
          if (next[cid]) continue
          next[cid] = {
            baseModel: addBase, thinking: lv, provider: provider,
            vendorGroup: String(provider || "").split("-")[0] || provider,
            tier: /free|contributor/i.test(addBase) ? "T0-free" : "T1-pay-per-token",
            stable: false, identityUnknown: true, capabilities: {},
          }
          added++
        }
        if (added === 0) { setAddMsg("该模型各档位都已在池中"); return }
        setAddMsg("已加入 " + added + " 个档位：" + levels.join("、"))
        save(next)
      }
      function removeModel(cid) {
        if (Object.keys(models).length <= 1) { setAddMsg("池里只剩最后一个条目，不能删（档案要求 models 非空）"); return }
        const next = JSON.parse(JSON.stringify(models))
        delete next[cid]
        if (sel === cid) setSel(null)
        setConfirmRemove(false)
        save(next)
      }
      return React.createElement("div", { className: "ccl-row" },
        React.createElement("div", { style: { width: "300px", display: "flex", flexDirection: "column", gap: 4 } },
          React.createElement("div", { className: "ccl-card", style: { marginBottom: 8 } },
            React.createElement("div", { className: "ccl-title" }, "增加模型（DSH 已配置）"),
            dsList === null
              ? React.createElement("button", { className: "ccl-btn", onClick: loadDsModels }, "加载 DSH 模型列表")
              : React.createElement(React.Fragment, null,
                React.createElement("select", {
                  className: "ccl-input", style: { width: "100%", marginBottom: 6 },
                  value: addBase, onChange: function (e) { setAddBase(e.target.value) },
                },
                  React.createElement("option", { value: "" }, "选择模型…"),
                  dsList.filter(function (m) { return m && m.id && !baseInPool(m.id) }).map(function (m) {
                    return React.createElement("option", { key: m.provider + "/" + m.id, value: m.id }, m.id + "（" + m.provider + "）")
                  })),
                React.createElement("button", { className: "ccl-btn", onClick: addModel }, "一键加入全部档位"),
                addMsg ? React.createElement("div", { className: "ccl-hint" }, addMsg) : null,
                React.createElement("div", { className: "ccl-hint" }, "一次建该模型全部档位；新成员默认临时身份"))),
          entries.map(function (e) {
            const cid = e[0], m = e[1]
            const avg = m.capabilities ? Object.values(m.capabilities).filter(function (c) { return c && c.score != null }).reduce(function (a, c) { return a + c.score }, 0) / Math.max(1, Object.values(m.capabilities).filter(function (c) { return c && c.score != null }).length) : null
            return React.createElement("button", {
              key: cid, className: "ccl-tab" + (sel === cid ? " ccl-on" : ""),
              style: { textAlign: "left", borderBottom: "none" },
              onClick: function () { setSel(cid); setConfirmRemove(false) },
            },
              React.createElement("span", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
                React.createElement("span", {}, cid),
                React.createElement("span", { className: "ccl-num" }, avg != null ? fmt(avg, 1) : "--")))
          }),
          React.createElement("div", { className: "ccl-hint" }, "点击候选查看雷达图；stable=false 为临时成员（不参与充足性计数）")),
        selModel
          ? React.createElement("div", { className: "ccl-grow", style: { display: "flex", flexDirection: "column", gap: 10 } },
            React.createElement("div", { className: "ccl-card" },
              React.createElement("div", { className: "ccl-title" },
                sel,
                " ",
                React.createElement("span", { className: "ccl-badge " + (selModel.stable === false ? "warn" : "ok") },
                  selModel.stable === false ? "临时成员" : "稳定成员"),
                selModel.identityUnknown
                  ? React.createElement("span", { className: "ccl-badge brand", style: { marginLeft: 6 } }, "身份未知")
                  : null),
              RadarSvg({ values: Object.fromEntries(Object.entries(selModel.capabilities || {}).map(function (e) { return [e[0], e[1] && e[1].score] })) }),
              React.createElement("div", { className: "ccl-row" },
                React.createElement("button", { className: "ccl-btn", onClick: function () { toggleStable(sel) } },
                  selModel.stable === false ? "标记为稳定成员" : "标记为临时成员"),
                React.createElement("button", { className: "ccl-btn danger", onClick: function () {
                  if (confirmRemove) removeModel(sel)
                  else setConfirmRemove(true)
                } }, confirmRemove ? "确认移除出池？" : "移除出池"))),
            React.createElement("div", { className: "ccl-card" },
              React.createElement("div", { className: "ccl-title" }, "维度分数"),
              React.createElement("table", { className: "ccl-table" },
                React.createElement("thead", null,
                  React.createElement("tr", null,
                    React.createElement("th", {}, "维度"), React.createElement("th", {}, "分数"),
                    React.createElement("th", {}, "样本"), React.createElement("th", {}, "来源"))),
                React.createElement("tbody", null,
                  DIMS.map(function (d) {
                    const c = selModel.capabilities && selModel.capabilities[d]
                    return React.createElement("tr", { key: d },
                      React.createElement("td", {}, DIM_LABEL[d]),
                      React.createElement("td", { className: "num" }, c && c.score != null ? fmt(c.score, 1) : "--"),
                      React.createElement("td", { className: "num" }, c && c.samples != null ? c.samples : "--"),
                      React.createElement("td", {}, c && c.interpolated ? "插值" : "实测"))
                  })))))
          : React.createElement("div", { className: "ccl-grow" },
            React.createElement("div", { className: "ccl-empty" }, "选择左侧候选查看详情"))
      )
    }

    // ---------- Tab 3 定价与成本 ----------
    function PricingTab(props) {
      const s = props.state || {}
      const pricing = s.pricing || {}
      const [draft, setDraft] = React.useState(null)
      const [saved, setSaved] = React.useState(0)
      const providers = pricing.providers || {}
      function openEdit(provider, model) {
        const p = providers[provider]
        const m = p && p.models && p.models[model]
        if (!m) return
        setDraft({
          provider: provider, model: model,
          inPeak: m.inputCnyPerMTok && m.inputCnyPerMTok.peak,
          inOff: m.inputCnyPerMTok && m.inputCnyPerMTok.offpeak,
          outPeak: m.outputCnyPerMTok && m.outputCnyPerMTok.peak,
          outOff: m.outputCnyPerMTok && m.outputCnyPerMTok.offpeak,
        })
      }
      function saveDraft() {
        if (!draft) return
        const next = JSON.parse(JSON.stringify(pricing))
        const m = next.providers[draft.provider].models[draft.model]
        m.inputCnyPerMTok = { peak: Number(draft.inPeak) || 0, offpeak: Number(draft.inOff) || 0 }
        m.outputCnyPerMTok = { peak: Number(draft.outPeak) || 0, offpeak: Number(draft.outOff) || 0 }
        fetch("/api/council/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ pricing: next }),
        }).then(function (r) { return r.json() })
          .then(function () { setDraft(null); setSaved(Date.now()); props.reload() })
      }
      return React.createElement("div", { className: "ccl-root", style: { padding: 0 } },
        Object.keys(providers).map(function (pid) {
          const p = providers[pid]
          const models = p.models || {}
          return React.createElement("div", { key: pid, className: "ccl-card" },
            React.createElement("div", { className: "ccl-row" },
              React.createElement("div", { className: "ccl-title" }, pid),
              React.createElement("span", { className: "ccl-badge brand" }, p.type || "")),
            React.createElement("table", { className: "ccl-table" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", {}, "模型"), React.createElement("th", {}, "输入 高峰/低谷"),
                  React.createElement("th", {}, "输出 高峰/低谷"), React.createElement("th", {}))),
              React.createElement("tbody", null,
                Object.keys(models).map(function (mid) {
                  const m = models[mid]
                  const inP = m.inputCnyPerMTok || {}, outP = m.outputCnyPerMTok || {}
                  return React.createElement("tr", { key: mid },
                    React.createElement("td", {}, mid),
                    React.createElement("td", { className: "num" },
                      (inP.peak != null ? inP.peak + " / " + inP.offpeak : "免费")),
                    React.createElement("td", { className: "num" },
                      (outP.peak != null ? outP.peak + " / " + outP.offpeak : "免费")),
                    React.createElement("td", {},
                      React.createElement("button", { className: "ccl-btn", onClick: function () { openEdit(pid, mid) } }, "编辑")))
                })))
          )
        }),
        draft
          ? React.createElement("div", { className: "ccl-card" },
            React.createElement("div", { className: "ccl-title" }, "编辑 " + draft.provider + " / " + draft.model + "（元/百万 token）"),
            React.createElement("div", { className: "ccl-row" },
              React.createElement("span", { className: "ccl-hint" }, "输入高峰"), React.createElement("input", { className: "ccl-input", value: draft.inPeak, onChange: function (e) { setDraft(Object.assign({}, draft, { inPeak: e.target.value })) } }),
              React.createElement("span", { className: "ccl-hint" }, "低谷"), React.createElement("input", { className: "ccl-input", value: draft.inOff, onChange: function (e) { setDraft(Object.assign({}, draft, { inOff: e.target.value })) } }),
              React.createElement("span", { className: "ccl-hint" }, "输出高峰"), React.createElement("input", { className: "ccl-input", value: draft.outPeak, onChange: function (e) { setDraft(Object.assign({}, draft, { outPeak: e.target.value })) } }),
              React.createElement("span", { className: "ccl-hint" }, "低谷"), React.createElement("input", { className: "ccl-input", value: draft.outOff, onChange: function (e) { setDraft(Object.assign({}, draft, { outOff: e.target.value })) } }),
            ),
            React.createElement("div", { className: "ccl-row" },
              React.createElement("button", { className: "ccl-btn", onClick: saveDraft }, "保存"),
              saved > 0 ? React.createElement("span", { className: "ccl-save", key: "s" + saved }, "✓ 已保存") : null,
              React.createElement("button", { className: "ccl-btn", onClick: function () { setDraft(null) } }, "取消")))
          : null,
        props.state && !props.state.pricing ? React.createElement("div", { className: "ccl-empty" }, "暂无定价档案") : null,
      )
    }

    // ---------- Tab 4 运行记录 ----------
    function RunsTab(props) {
      const runs = props.state && props.state.runs ? props.state.runs : []
      const [sel, setSel] = React.useState(null)
      const selRun = runs.find(function (r) { return r.run === sel })
      function detailText(r) {
        if (!r || !r.result) return ""
        const lines = []
        lines.push("状态：" + statusLabel(r.result.status) + " · 档位：" + (r.result.tier || "--") + " · 轮数：" + r.result.rounds)
        lines.push("S_r 轨迹：" + JSON.stringify(r.result.s_history || []))
        lines.push("报告路径：" + (r.result.report || ""))
        lines.push("")
        if (r.result.inline_text) lines.push(r.result.inline_text)
        return lines.join("\n")
      }
      return React.createElement("div", { className: "ccl-row" },
        React.createElement("div", { style: { width: "240px", display: "flex", flexDirection: "column", gap: 4 } },
          runs.length === 0
            ? React.createElement("div", { className: "ccl-empty" }, "暂无运行记录")
            : runs.map(function (r) {
              return React.createElement("button", {
                key: r.run, className: "ccl-tab" + (sel === r.run ? " ccl-on" : ""),
                style: { textAlign: "left", borderBottom: "none" },
                onClick: function () { setSel(r.run) },
              },
                React.createElement("span", { style: { display: "flex", justifyContent: "space-between", gap: 6 } },
                  React.createElement("span", {}, r.run),
                  React.createElement("span", { className: "ccl-num" }, r.result ? statusLabel(r.result.status) : "未完成")))
            })),
        selRun
          ? React.createElement("div", { className: "ccl-grow" },
            React.createElement("div", { className: "ccl-detail" }, detailText(selRun)))
          : React.createElement("div", { className: "ccl-grow" },
            React.createElement("div", { className: "ccl-empty" }, "选择左侧 run 查看详情")))
    }

    // ---------- Tab 5 自改进 ----------
    function EvolutionTab(props) {
      const s = props.state || {}
      const caps = s.caps || {}
      const meta = caps.meta || {}
      return React.createElement("div", { className: "ccl-root", style: { padding: 0 } },
        React.createElement("div", { className: "ccl-card" },
          React.createElement("div", { className: "ccl-title" }, "能力档案自进化"),
          React.createElement("div", { className: "ccl-desc" }, meta.note || "（无备注）"),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "当前 revision"),
            React.createElement("span", { className: "v ccl-num" }, caps.revision || 0)),
          React.createElement("div", { className: "ccl-kv" },
            React.createElement("span", { className: "k" }, "运行期反馈 run 数"),
            React.createElement("span", { className: "v ccl-num" }, caps.runtimeFeedback ? caps.runtimeFeedback.totalRuns : 0)),
          React.createElement("div", { className: "ccl-desc" },
            "结构级改动（评分函数/护栏/判据/维度集）走提案→独立评审→A/B 试运行→Robert 终审双门槛；参数与能力分自动进化（拐点 20 样本、10 次 run 翻排名）。")))
    }

    // ---------- 主组件 ----------
    const TABS = [
      { id: "dash", label: "总览", render: Dashboard },
      { id: "models", label: "模型与能力", render: ModelsTab },
      { id: "pricing", label: "定价与成本", render: PricingTab },
      { id: "runs", label: "运行记录", render: RunsTab },
      { id: "evolve", label: "自改进", render: EvolutionTab },
    ]

    function Console(props) {
      const { state, err, reload } = useCouncilState()
      const [tab, setTab] = React.useState("dash")
      const active = TABS.find(function (t) { return t.id === tab }) || TABS[0]
      return React.createElement("div", { className: "ccl-root" },
        React.createElement("div", { className: "ccl-tabs" },
          TABS.map(function (t) {
            return React.createElement("button", {
              key: t.id, className: "ccl-tab" + (tab === t.id ? " ccl-on" : ""),
              onClick: function () { setTab(t.id) },
            }, t.label)
          })),
        err ? React.createElement("div", { className: "ccl-err" }, err) : null,
        state ? React.createElement(active.render, { state: state, reload: reload })
          : React.createElement("div", { className: "ccl-empty" }, "加载中…"))
    }

    // 侧边栏常驻卡片（议会状态：汇率 + 最近 run；余额/额度已由成本监控卡片负责，不重复）
    function SidebarCard(props) {
      const { state } = useCouncilState()
      const fx = state && state.fx ? state.fx : {}
      const runs = state && state.runs ? state.runs : []
      const latest = runs.find(function (r) { return r && r.result }) || null
      return React.createElement("div", {
        className: "cm-card", style: {
          display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px",
          margin: "0 8px 6px", border: "1px solid var(--dsw-alias-border-l1)",
          borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", fontSize: 11,
        },
      },
        React.createElement("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "Council"),
        React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
          "$/¥ " + (fx.usdToCny || "--") +
          (fx.publishDate ? " · " + String(fx.publishDate).slice(0, 10) : "") +
          (fx.stale ? "（待更新）" : "")),
        React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
          latest ? "最近：" + statusLabel(latest.result.status) + " · " + (latest.result.rounds != null ? latest.result.rounds : "–") + " 轮" : "暂无运行"))
    }

    function apply(ctx) {
      // FIX 2026-09-05：slots 是硬依赖（与 dsh-cost-monitor / 官方 client 一致）。
      // 之前用 ctx.get("slots") + undefined 静默 return，新版模块物化顺序提前时
      // apply 跑在 slots 服务就绪之前，侧栏卡和设置页双双消失且零报错。
      const slots = ctx.slots
      slots.inject("sidebar.footer.action", function () {
        return slots.register(
          { name: "sidebar.footer.action", id: "council", order: 1 },
          function (props) { return React.createElement(SidebarCard, props) },
        )
      })
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "council-console", order: 40, label: function () { return "Council 控制台" } },
          function (props) { return React.createElement(Console, props) },
        )
      })
    }

    exports.apply = apply
    exports.inject = ["slots"]
    return module.exports
  }
})
