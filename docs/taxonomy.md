# DSH 失败分类（本机语料，2026-10）

统计口径：`Incident` = 去重后的事件（同一指纹只算 1 条）；`命中` = 该签名在 artifact 里出现的次数。5 条 Incident / 16 命中共 7 个类；另有 6 条 `obs_*` 观测支撑降级类。本机没有原生崩溃，也没有 ESM 解析失败实例——这两类按 0 计，只在规则层保留。

| # | 类 | Incident | 命中 | 严重度 | 规则 |
|---|---|---|---|---|---|
| 1 | 宿主进程未捕获异常 | 2 | 7 | fatal | R001 R002 R003 R004 R005 |
| 2 | 插件激活失败 | 1 | 3 | boot | R008 R009 R010 |
| 3 | 配置校验错误 | 1 | 1 | boot | R006 |
| 4 | web boot 部分失败 | 1 | 5 | boot | R007 R008 |
| 5 | 缺失服务 / 注入 | 1（派生） | 1 | boot | R006 R007 |
| 6 | ESM / 导入错误 | 0 | 0 | boot | R011 R012 |
| 7 | 渲染 / 客户端构建错误 | 1 | 3 + 31 | boot/lint | R009 R017 R018 |
| 8 | 原生崩溃 | 0 | 0 | fatal | — |
| A | 依赖遮蔽（社区） | 0（外部 1） | 1 | fatal | R016 R023 |
| B | 会话损坏 / 隔离 | 0（观测 1） | 2 | lint | R022 |
| C | 热重载降级 | 0（观测 1） | 7 | lint | R020 R021 |
| D | 配置卫生（重复 id） | 0（配置证据） | 0 | boot | R013 R014 R015 |

---

## 1. 宿主进程未捕获异常（fatal，2 条 / 7 命中）

**症状**：`crash-*-host.log` 的 error 段是 `Error: dsh desktop host exited with 1: dsh: fatal uncaught exception: TypeError: …`，随后整个窗口消失；再启动时新 shell pid，几秒内可能再崩一次（本机四连崩 09:22:59 / 09:23:08 / 09:23:15 / 09:23:22）。

**证据**：
- `inc_42a251011fd8` `TypeError: this.holding is not a function`，第一帧 `sidecar.js?v=1:743:20`，第二帧 `WebSocket.<anonymous> (sidecar.js?v=1:337:46)` —— CDP 截图帧回调里调了别的方法。
- `inc_9c8c3f934d27` `TypeError: this.killStale is not a function`，第一帧 `LiveStream.stop (stream.js?v=141:827:33)`，第二帧 `Timeout._onTimeout` —— 空闲回收定时器里调了重构后已改名的方法。

**根因模式**：异常不是发生在顶层，而是发生在**宿主自己调用的异步边界**里（EventEmitter/WS 事件、`setTimeout` 回调、子进程 close）。这类回调不经过插件 `apply()` 的 try/catch，Node 又没有兜底，`uncaughtException` 直接结束进程。第二层根因是**悬空 `this.X()`**：同名类里换了实现（`holding`/`killStale` 从内部方法变成外部注入或改名），调用点没跟着改，只有执行到那条路径才炸——所以能稳定复现又难在测试里覆盖。

**影响面**：整个 Desktop host 进程 + 所有在跑会话，等于用户所有工作全部中断。不是单个视图坏掉。

**该落成什么规则**：R001（每个事件回调整体包 try/catch）、R002（定时器回调是独立故障域）、R003（流帧/WS 回调一帧失败只丢一帧）、R004（关闭/清理路径最容易漏兜）、R005（插件不得 `process.exit`）。**不要**给"回调里 throw"写 static guard —— 静态正则无法判断 throw 是否落在回调内（见 `rules.seed.json` 的 guard 说明）。

**上游修复写法（可抄）**：`dsh-inner-browser-use` 0.34.34 把 `holdOf` 通过构造函数注入 `SidecarPage`，并给 screencast 回调加"一帧坏了不能带走应用"的注释级 fault boundary。

## 2. 插件激活失败（boot，1 条 / 3 命中）

**症状**：渲染进程 console 出现 `Uncaught SyntaxError: Unexpected end of input`，地址形如 `dsh-app://app/plugins/??<plugin>/client.js&rev=<rev>:<line>`，同一行重复多次。

**证据**：`inc_baa187281b4e` — `dsh-mobile-use/client.js` rev `f16dd6f32014` 第 1497 行，3 次。宿主还活着，插件入口完全没执行，插件等于不存在。

**根因模式**：client bundle 被服务成半截（拼接丢尾）或被语法错误截断，浏览器解析阶段就失败，`activate()` 根本没轮到。这类错误**不会**出现在 host 崩溃栈里，只出现在 host 日志的 renderer console 段——只看 `--- error ---` 会漏。同类已知形态：顶层重复声明（`Identifier … has already been declared`）也会让整个 client bundle 不执行。

**影响面**：一个插件的全部界面/命令消失，且宿主视角"没报错"。

**该落成什么规则**：R008（入口没激活会让 web boot 整体报失败）、R009（client.js 改完先 `node --check`）、R010（顶层不要重复声明）。

## 3. 配置校验错误（boot，1 条 / 1 命中）

**症状**：startup 日志 `StartupError: dsh: startup failed: 1 required plugin did not activate`，失败表里是 `ValidationError: invalid config: $.provider missing required value (at provider)`，栈落在 `cordis/lib/index.js:960 resolveConfig`。

**证据**：`inc_b922a17703ff`，profile `bench`，`configurationPath: ~/.dsh/profiles/bench/cordis.yml`。

**根因模式**：schema 校验在 `resolveConfig` 阶段失败，插件 fiber 根本没起来；一个必填字段缺失 = 进程起不来，不是降级。

**影响面**：整个 profile 启动失败（本次 `bench`），桌面 profile 不受影响——所以它容易被当成"只有某个环境坏了"。

**该落成什么规则**：R006（必填配置缺失让整进程启动失败，报错指到字段路径）。

## 4. web boot 部分失败（boot，1 条 / 5 命中）

**症状**：`crash-*-web-boot.log`（636 B，只有 header + error 段）：`web boot: 1 entry did not activate (dsh-vantage: failed)`。宿主进程活着，重启/重载 5 次全一样（09:15:39 → 09:19:47）。

**证据**：`inc_6f3d721bddaf`。上游修复合入 `dsh-vantage` `33fb8b7` "register the overview view through the slot graph so the client entry activates"。

**根因模式**：client entry 注册视图时绕过 slot 图（自己挂 DOM / 自己 `inject` 未声明的 service），激活抛错被 boot 审计捕获并上报 `DESKTOP_IPC.bootFailed → reportFatal(err, "web-boot")`。**source 是渲染层上报的**，所以是 `-web-boot.log` 而不是 `-host.log`。

**影响面**：整个 Web UI boot 被判失败（虽然宿主进程在），用户看到的是"界面起不来"，一个插件能拖垮所有插件的界面。

**该落成什么规则**：R007（一个必填入口失败会连锁停掉等待者）、R008。

## 5. 缺失服务 / 注入（boot，1 条派生 / 1 命中）

**症状**：startup 日志里 `plugins waiting for services (1): headless-runner (required) -> agentDefaultModel`，与 #3 同一次启动。

**根因模式**：`inject` 声明了某个 service，提供者因为 #3 没起来，等待者按契约只能等——于是"缺失服务"其实是"提供者崩了"的二级症状。诊断时先看失败表，再看等待表；只看等待表会一直以为是 enable 顺序问题。

**影响面**：依赖链上所有插件停摆。

**该落成什么规则**：R007（等待者不会自愈，先修提供者）。

## 6. ESM / 导入错误（boot，本机 0 条）

没有实例。这一类按契约要覆盖，规则只写"可静态检查"的部分：`type: "module"` 的插件里出现 `require(` 会在加载期直接 `ReferenceError`；顶层 `throw`/`await` 会让激活挂住或失败。两者都能用源码正则命中，放进 guard。

## 7. 渲染 / 客户端构建错误（boot + lint，1 条 / 3+31 命中）

**症状（致命）**：同 #2（`Unexpected end of input`）。
**症状（降级，只出现在 renderer console 段）**：
- `Unable to preventDefault inside passive event listener invocation.` ×30（`index-BXV-oxvX.js:172`）——手势被声明成 passive 后 `preventDefault()` 无效，页面照常滚动；
- `ResizeObserver loop completed with undelivered notifications.` ×1——布局回调里同步改被观察尺寸；
- `Sidebar: Session opening failed: Session reference "…" is released` ×1——会话引用释放后还在打开。

**根因模式**：同一个 client bundle 里，语法/构建问题会升级成"插件消失"，而运行时 console 报错只降级为"行为不对"。两类都吃 `--- renderer console (error level, oldest first) ---` 这一段，段不存在时日志里字面写着 `(no error-level renderer console output was captured)`。

**影响面**：降级类不影响宿主，但界面行为静默错（该拦的滚动没拦、该刷的布局丢了）。

**该落成什么规则**：R009、R017、R018、R019。

## 8. 原生崩溃（fatal，本机 0 条）

`~/Library/DiagnosticReports/` 没有 `DeepSeek*` / `Electron*` / `node` 报告，即没有 SIGSEGV/SIGABRT 实例。**不要为了凑类编一条**；规则层也不写 native 相关规则，等真有 `.ips` 再补（需要解析 `termination.signal` 与 `faultingThread`）。

---

## 附加：观测到的类（不在契约的 8 类里，但对"预防"有信息量）

**A. 依赖遮蔽 / 双 runtime（fatal，外部 1 条）** — 社区 [discussion #1337](https://github.com/deepseek-ai/deepseek-harness/discussions/1337)：profile 里装了第二份 `@deepseek-ai/dsh-tools`，per-module `Symbol()` 对不上，第一轮工具调用就 `Cannot read properties of undefined (reading 'prepare')`，并且悬空 `tool_calls` 让会话永久不可恢复（400）。规则 R016、R023。本机没有对应 artifact，`obs_c7f827952abc` 只标 `external`，**不伪造 Incident**。

**B. 会话损坏 / 隔离（lint，2 次）** — `~/.dsh/sessions-quarantine/2026-10-25-Pet/` 下 2 个会话被移出主库。隔离而非删除是正确的：日志/证据还能捞。规则 R022。

**C. 热重载降级（lint，7 命中共）** — `~/.dsh/unlag-reload.log`：`cannot answer /plugins/??…client.js&rev=… at the revision the app serves now: fetch failed`，以及 6 次 `the press was answered as failed and the page never said what it did`。改完插件不断言 revision 一致，用户就会看到"点了没反应"。规则 R020、R021。

**D. 配置卫生（boot 风险，配置证据）** — 活的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `- id: ui-chat` 出现两次（99 / 180 行）、`- id: remote-web-ui` 出现两次（9 / 208 行，后者 `disabled: true`）。后者静默生效，前面写的 `transcriptView: compact` 之类配置被覆盖且无提示。规则 R013、R014、R015。

---

## 采集器必须解析的格式（给 core.mjs）

1. **crash 日志 = 扁平 header + 分段正文**。文件名 `crash-<ISO 用下划线>-{host|web-boot}.log`；header 每行 `key: value`：`time/source/phase/app/platform/electron/node/locale/shell pid`。**`time:` 是权威时间**（文件名与它可差几十毫秒）。`source` 与后缀一一对应，不要从正文猜。
2. **error 段在 `--- error ---` 之后**，到下一个 `--- … ---` 或 EOF；host 类的错误首行恒为 `dsh desktop host exited with <code>[: <stderr>]`，真因在 `dsh: fatal uncaught exception: …` 之后。
3. **renderer console 段可选**，缺省时字面写着 `(no error-level renderer console output was captured)`；有则每行 `<source>:<line> <message>`，会出现同一消息重复几十次 → 归一化时按签名聚合计数，不要按行造事件。
4. **startup 日志不是 JSON**：对象 dump（单引号、`[Getter/Setter]`、跨行 stack、`'null'`）。别 `JSON.parse`，用宽松括号扫描逐字段取 `failed plugin / waiting-for-service / configurationPath / dshVersion`。
5. **会话 transcript 是 zstd**（`session.v4.jsonl.zstd`）。崩溃原文可能只活在这里（本机 killStale 那条就是），所以采集器的兜底路径要能解压 + 从旧会话里回捞 artifact 文本，并标注"来源=会话记录，时间戳有分钟级误差"。
6. **签名归一化**：把 pid、绝对路径、`rev=`、UUID、端口去掉，只留 `类型 · 消息` 与肇事帧 `文件:行`；否则同一 bug 每崩一次都是新事件（本机 10 份日志本应只有 3 条）。
