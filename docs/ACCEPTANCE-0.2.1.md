# dsh-crash-lore 0.2.1 独立验收报告（Agent C）

- 验收对象：`/Users/apple/Desktop/DSH/dsh-crash-lore`，version `0.2.1`，以 `link:` 装入真实宿主 profile `~/.dsh/profiles/desktop`。
- 验收时间：2026-10-28T23:49:38+08:00 ～ 2026-10-29T00:03+08:00（UTC 记录见各 JSON 的 `at`）。中间 A 先落盘 guard.mjs 批量语法检查（23:54），再按 Lead 决定落盘安装路径 fail-closed（00:00）；**产品代码 2026-10-29 00:01 起正式冻结**，本报告数字均为冻结后快照。历史数据与新数据分两段记录。
- 最终判定：**自动门禁通过 / 真机加载激活 PASS（第 9 项）/ 真机进程内拦截 PASS（第 10 项）/ 交互式真机未验证**。矩阵 29 PASS / 0 FAIL / 0 XFAIL、`npm test` 92/92、`verify` 6/6、冷装 28/28、extras 5/5、adversarial 6/6（exit 0）全绿；第 10 项补上「真实宿主进程里的 guard 决策 + 拒绝载荷 + 文件 sha 不变」；仍缺模型交互半边（同会话存活、PTC 回传、三档切换、重启后 `set_plugin`），**不写整体 PASS**。第 7 项从历史 FAIL 转为 PASS（冻结后实测 1.3 ms），历史数字保留不改写。第 3 项对抗用例先暴露安装预算 fail-open、A 修复后再验 fail-closed，修复前后两段证据均保留。
- 环境：macOS；真实宿主 pid 90362（启动于 2026-10-28 17:28:53）；插件源码最后修改 2026-10-28 23:40 ～ 2026-10-29 00:00，**晚于宿主启动**，故真实宿主进程内加载的不是 0.2.1 最终代码（见「真机状态」）。截至 00:10 复核，该 entry 已 `fiberPhase: failed`、`crash_lore_*` 工具不可见，**本机当前防护是关的**；本宿主的动态重载通道同时失效，只能靠重启加载 0.2.1。
- 证据来源标记：
  - `[自动·进程内]`：`test/integration/*` 用插件真实 `apply()`、真实注册的 guard/pre-execute handler，在 mock profile 上跑；不是真实宿主。
  - `[只读检查]`：只读真实 profile / 真实进程状态，未写入。
  - 真实宿主的第二会话 / 真实 PTC 本轮**未覆盖**：宿主不重启无法加载 0.2.1，重启会杀掉当前会话；这两项一律写「未覆盖 · 待重启宿主后验证」，来源列写「无（未取得）」。已取得的真机证据只有首轮那条 `[CRASH_LORE_BLOCKED]` 拒绝字符串。
  - 所有测试只写 `/tmp` 或临时 profile；未修改产品代码、未动真实 profile（Lead 的合法激活尝试已还原，见末节）。

## 1. 结果总表

| # | 验收项 | 判定 | 关键证据 | 证据来源 |
|---|---|---|---|---|
| 1 | 真实 `write` 崩溃形态被拒、sha256 不变、改正后可写 | **PASS** | 5 条 c1-* 全绿；`c1-file-unchanged` 字节一致；`c1-side-effect-absent` 无执行痕迹 | `[自动·进程内]`；真机仅首轮 `[CRASH_LORE_BLOCKED]` 单条（来源：真实宿主） |
| 2 | 绝对/相对/symlink 同一文件判定一致，含 0.2.0 漏洞 | **PASS** | `c2-relative-path`、`c3-symlink-dir` 0.2.0 会 ALLOW，现均 deny P014 | `[自动·进程内]` |
| 3 | 坏插件安装被拒；`set_plugin(entry id)`/`set_bundle` 不能绕过；超预算时 fail-closed | **PASS** | `c4`/`c5`/`c6`/`c7` 全 deny；adversarial 6/6：20×1.5 MB 坏入口 deny P013、5 ms 预算注入 deny `uninspected`、20 个大而合法入口 allowed | `[自动·进程内]` |
| 4 | 其他会话的开发工作不受影响 | **PASS（进程内）**；真机第二会话 **未覆盖 · 待重启宿主后验证** | `c12-normal-write`、`c12-next-call-clean`、`c12-denial-scope`（仅 1 条新记录） | `[自动·进程内]`；真机来源：无（未取得） |
| 5 | PTC `run_code` 子调用拒绝能到达发起 agent | **PASS（进程内载荷）**；真机 PTC **未覆盖 · 待重启宿主后验证** | `c13-ptc-payload`：`code=CRASH_LORE_BLOCKED`、`rule=P014`、含位置/建议/重新提交 | `[自动·进程内]`；真机来源：无（未取得） |
| 6 | guard/observe/off 状态与行为一致，off 真不拦 | **PASS** | `c9-*` 开启=拒绝；`c10-*` 仅监测=放行但记录、`hooks.write=sync && pre=async`；`c11-*` 关闭=放行且 0 新记录 | `[自动·进程内]` |
| 7 | 20 entry 预检计时，>200 ms 判失败 | **历史 FAIL → 修复后 PASS** | 历史 `preflight()` 421.3–533 ms（20×node --check≈21.5 ms/个）；A 批量解析落盘后 **1.3 ms**（首次 31.0 ms 含子进程） | `[自动·进程内]` |
| 8 | `npm pack` + 临时 profile 冷装，产物/默认路径/无作者数据 | **PASS** | 冷装 28/28；tgz 76899 B；defense/locale/seed 齐全；`p18` 零作者 incident | `[自动·进程内]`（临时 DSH_HOME） |
| 9 | 0.2.1 被**真实宿主进程**的 loader 加载并激活（不是进程内 mock） | **PASS** | `real-host-activation.mjs` 6/6（单次 1.2–3.0 s）；`--dump-config` 合成树第 385 行含 `dsh-crash-lore`；boot 无 `did not activate`、无 `(dsh-crash-lore)` 报错并走到 `MISSING_CREDENTIAL`（= 整棵树已 mount） | `[真机·真实宿主进程]`（临时 DSH_HOME + 出厂 headless 模板；仓库 link 与 registry 产物各 6/6；交互式 a–e 仍待重启） |
| 10 | 0.2.1 在**真实宿主进程**里对真实工具调用做出拦截决策（不是进程内 mock） | **PASS** | `real-host-guard.mjs` 13/13（2.0–2.4 s）：fixture 经宿主自己的 `ctx.tools.execute()` 写入，危险写收到 `[CRASH_LORE_BLOCKED]` + `P013` + 位置/原因/建议；同进程的正常写成功（无过度拦截）；被拒 `index.js` sha256 `9428e512…` 前后一致；boot 无 worker/loader 崩溃 | `[真机·真实宿主进程]`（临时 DSH_HOME + 出厂 headless 模板 + 临时 fixture 包；无模型交互） |

汇总 JSON：`/tmp/cl-acceptance-verify.json`（编排器）、`/tmp/cl-acceptance-matrix.json`、`/tmp/cl-acceptance-cold-install.json`、`/tmp/cl-acceptance-extras.json`。

## 2. 逐项证据

### 第 1 项 写前拦截（PASS）

命令：`node test/integration/matrix.mjs`（strict，已清空 `KNOWN_020_HOLES`）

```
PASS c1-absolute-deny            拒绝并给整改建议
PASS c1-remediation-text         含「改好后重新提交这次写入」
PASS c1-file-unchanged           目标 sha256 前后一致
PASS c1-corrected-write-allowed  改正后 write 返回 undefined（放行）
PASS c1-side-effect-absent       /tmp/cl-acceptance-should-not-run.marker 不存在
```

判定：内容里的顶层 throw / 裸 await 等 P0 形态不落盘、不执行；拒绝文本给出可执行修正路径。

### 第 2 项 路径一致性（PASS，修复 0.2.0 两处漏洞）

| 用例 | 0.2.0 行为（历史） | 0.2.1 实测 |
|---|---|---|
| `c2-relative-path`：进程 cwd=profile，写入相对路径 `workspace/dev-plugin/probe.mjs` | ALLOW（按宿主 cwd 解析，写错地方/漏检） | **deny P014**，与绝对路径同一判定 |
| `c3-symlink-dir`：经 `profile/node_modules/dev-plugin` 目录 symlink 写同一文件 | ALLOW（未 realpath，绕过 live 判定） | **deny P014**；`c3-same-file-check` 证明 symlink 指向同一真实目录 |

实现依据（只读代码核对）：`lib/resolve.mjs` 的 `canonicalPath` 对最深存在祖先 realpath 后拼缺失尾段，`sessionCwd` 用会话 cwd 而非宿主 cwd；`lib/judge.mjs` 与 `defense.mjs` 共用该解析。

### 第 3 项 安装/启用侧（PASS，含 fail-closed）

```
PASS c4-install-bundle          install_bundle 坏插件 → deny
PASS c5-set-entry-aligned        set_plugin include:<同名 id> → deny
PASS c6set-entry-id-mismatch     include:bad → dsh-bad-plugin（entry id ≠ 包名）→ deny P014
PASS c7-set-bundle               set_bundle 坏 bundle → deny
PASS c7-unresolved-fails-closed  目标无法解析 → deny rule=uninspected（不是跳过）
```

说明：c6 早前在 0.2.0 baseline 是 XFAIL（`include:bad` 映射不到 `dsh-bad-plugin` 的候选目录）。0.2.1 用 `entryIndex()` 从 bundle 自身 patch 行建立 `include:<row id> → 模块目录` 映射后通过。验收脚本此前的 fixture 漏了 `package.json` 的 `dsh.bundle.patch` 指针（真实 bundle 必有），已修正为真实形状；这是测试缺陷，不是产品放水。c7 的旧断言「必须解析出目录」已改为「解析不出即 fail-closed 拒绝」，与新语义一致。

### 第 3 项附加：安装预检预算，修复前 fail-open → 修复后 fail-closed（矩阵外）

**修复前实况（保留原证据）**：install 预检按 150 ms 预算跑，见 `/tmp/cl-acceptance-adversarial-before.txt`（2 pass / 1 fail，exit 1）。

```
FAIL  a1-install-refuses-broken · expected: install_bundle denies a syntax-broken plugin
      actual: ALLOWED (budget fail-open)
PASS  a1-preflight-budget-status · {"checked":0,"cached":0,"unchecked":20,"budgetHit":true}
PASS  a1-preflight-no-p013 · no P013 in 0 finding(s)
```

fixture：bundle 20 个 entry（19 个约 1.5 MB 合法 ESM，最后一个 `export function apply( {` 语法错误）。`preflight(dir,{budgetMs:150})` 162 ms 返回 0 findings；真实 `install_bundle` handler 返回 `{"kind":"next"}`，即坏插件被放行。当时矩阵 5 个坏样本仍全拒，所以矩阵是绿的，但「检查没跑完就当通过」这个口子确实存在。

**修复后（产品冻结快照，`node test/integration/adversarial.mjs --strict` → 6 pass / 0 fail，exit 0）**：

```
PASS  a1-preflight-budget-status  write-side preflight(150 ms) 仍是 unchecked、无 P013（写前 fail-open 预算未动）
PASS  a1-preflight-no-p013       raw preflight(150 ms) 不产生 P013
PASS  a1-install-refuses-broken  20×1.5 MB 坏入口 → denied P013（冷跑约 650 ms，重试后查完）
PASS  a2-tiny-budget-refuses-uninspected  preflightCandidate(dir, 5 ms) → uninspected，0 checked / 20 unchecked
PASS  a2-uninspected-not-syntax  文案只说「预检未完成…本次安装被拒绝」，不冒充语法错误
PASS  a3-large-legal-allowed     20 个大而合法的入口 → allowed（约 991 ms，不是无脑拒大包）
```

机制：安装/启用路径 `preflightCandidate()` 默认 3000 ms，预算内 `unchecked > 0` 时单次重试，仍 `unchecked > 0` 或预检异常 → `ruleId:'uninspected'`（severity `boot`）硬拒；写前检查与 c14 仍是 fail-open、预算未动。原缺陷已在 `defense.mjs` 修复，本轮只复验不改产品代码。

### 第 4 项 不干扰其他会话（PASS）

```
PASS c12-normal-write        非 live 文件 write → allowed
PASS c12-next-call-clean     上一次拒绝不污染下一次调用
PASS c12-denial-scope        本次只新增 1 条拒绝记录（用 before/after 差值断言）
```

真实第二会话本轮**未覆盖**（宿主不重启无法加载 0.2.1，重启会杀掉当前会话），待重启后验证；来源：无（未取得）。本报告不代替真实会话结论。

### 第 5 项 PTC 子调用回传（PASS，进程内载荷）

`c13-ptc-payload` 校验拒绝结构可跨 `run_code` 子调用返回发起方：`code=CRASH_LORE_BLOCKED`、`rule=P014`、含文件位置、整改建议、「改好后重新提交」。真实 PTC 调用由 Lead 补测，原文未附于本报告，故只标来源不加数字。

### 第 6 项 三模式（PASS）

命令同上。断言以 `state.mjs` canonical 值为准（`protect|observe|off`，中文只在 `modeLabel`）：

```
PASS c9-mode-guard        mode=protect · modeLabel=开启 · hooks.write=sync · hooks.preExecute=async
PASS c9-guard-denies      开启下危险写被拒
PASS c10-mode-monitor-text  mode=observe, modeLabel=仅监测，两个 hook 均已注册
PASS c10-monitor-allows   仅监测下 write 放行
PASS c10-monitor-records  仅监测下仍记录 1 条
PASS c11-mode-off         mode=off · modeLabel=关闭 · hooks=null
PASS c11-off-allows       关闭下 write 放行
PASS c11-off-no-record    关闭下 0 条新记录（真不检查）
```

注意：`crash_lore_guard` 的 `mode` 是 canonical 值；界面/文本里出现「保护中」「已关闭」作为 mode *值* 属旧语义，0.2.1 已移除（仅 `modeLabel` 可为中文）。

### 第 7 项 预检性能（历史 FAIL → 修复后 PASS）

`guard.mjs` 的 `preflight(dir)` 对每个文件 spawn 一次 `node --check`；20 个 entry 目录（20 个 `index.js`）实测。**历史数据（0.2.1 落盘前，A 修复 guard.mjs 之前）**，保持原样不改写：

```
FAIL  c14-perf-200ms  expected < 200 ms, actual 421.3 ms (samples 440.1, 427.3, 421.3)
PASS  c14-perf-findings  20 个文件 0 误报
PASS  c14-perf-attribution  20 x node --check = 431 ms（21.5 ms/个）≈ 总耗时
```

历史多次观测区间 **421–533 ms**（同机复跑样本含 427.3/436.2/444.6/445.7/448.6/450.4/480.0/487.4 ms）；编排器内复跑 448.6 ms，归因子进程 452 ms（22.6 ms/个）。`guard.mjs` 采样时 mtime 22:26:30，本轮落盘的 guard.mjs 尚未改这条路径；按 Lead 指令保持红、不调预算。结论：第 7 项 **FAIL**，release 阻塞项。

**A 修复后（批量语法检查已落盘，产品 2026-10-29 00:01 冻结后快照）**

```
PASS  c14-perf-200ms       1.3 ms (samples 31.0, 1.3, 1.5)
PASS  c14-perf-findings    20 个文件 0 误报
PASS  c14-perf-attribution 20 次 spawn node --check = 450 ms（22.5 ms/个），但已不在 preflight 主路径
```

实现变化（只读核对）：`guard.mjs` 改为**一个子进程**用 `vm.SourceTextModule`/`vm.Script` 解析全部 entry（不执行），结果按 `(path, mtimeMs, size)` 缓存；首次 31.0 ms（含一次子进程启动），后续 1.3/1.5 ms；min=1.3 ms。独立正确性探针（验收侧另写，不进产品）：坏语法→P013、修好→0、同尺寸改写→无陈旧错误、再坏→P013、顶层 throw→P014；缓存未产生误报或漏报。**历史 FAIL 数字保留在本段上方，未用新数字覆盖。**

### 第 8 项 发布/冷装（PASS）

命令：`node test/integration/cold-install.mjs`（`npm pack` 到临时目录，`DSH_HOME` 与 profile 均为临时目录，用 `file:<tgz>` 安装）

```
PASS p2-tarball            dsh-crash-lore-0.2.1.tgz 72644B
PASS p3-ships-defense      defense.mjs + guard.mjs + index.js + cordis.patch.yml
PASS p4-ships-locale-seed  locale/en.json + locale/zh.json + rules.seed.json
PASS p5/p6/p7              corpus/、incident 日志、test/docs/scripts 均不发布
PASS p9/p10-*              安装后 node_modules 内容齐全（含 rules.seed/locale）
PASS p12-no-author-paths   发布源码无 /Users/apple 路径
PASS p13-locale-valid      en:2 / zh:2 flat keys
PASS p13b-import-closure   10 个相对 import 全解析
PASS p13c-syntax-all       10 个运行时文件 node --check 全过
PASS p14-boot / p15-mode   冷启动成功，protect/开启，capability=normal，write=sync pre=async
PASS p16-guard-works       冷装实例对 live 插件写 → 拒绝且文件未动
PASS p17-seed-rules        新 home 自动播种 23 条规则
PASS p18-no-author-incidents  0 incident 行、0 作者数据命中、0 误拒
PASS p19-paths-under-home  默认路径落在 home/crash-lore
PASS p20-no-side-effects   被拒内容未执行
```

备注：冷装用 `file:<tgz>` 规格；registry 风格安装的关键点是**包内必须自带 rules.seed.json、locale、worker/defense 代码**，p3/p4/p10 已验证存在（tgz 的 `files` 字段含 `state.mjs`、`lib/*.mjs`）。真实 registry 安装不在本轮执行范围。

### 第 9 项 真实宿主进程加载/激活（PASS，非 mock）

前 1–8 项都跑在进程内的假 ctx 上。为把「0.2.1 能不能被真实 loader 装上」这件事从「等重启」变成可重复的证据，新增 `scripts/real-host-activation.mjs`：用**出厂 DeepSeek Harness 启动器**（`/Applications/DeepSeek Harness.app/.../dsh-desktop-host/lib/cli.js`）在临时 `DSH_HOME` 里建一个 `--from-default-profile headless` 的一次性 profile，用真实安装路径 `dsh plugin --profile lab add link:<repo>` 装上本包，再真实 boot 一次。**不碰用户的 desktop profile，不需要模型 key**（boot 会停在 `MISSING_CREDENTIAL`，而该检查发生在整棵树 mount 之后）。

2026-10-29 00:15 原始输出（`node scripts/real-host-activation.mjs`，退出 0）：

```
PASS  profile created from shipped template — exit 0, 174 ms
PASS  package installed from disk —  / Done in 235ms using pnpm v11.28.5
PASS  entry present in composed profile tree — line 385
PASS  loader activated the entry (no "did not activate") — no activation warning
PASS  boot reached the credential wall (i.e. the tree mounted) — expected without a model key
PASS  apply() executed in the real host — no lore history to log (accepted)
PASS  real host activation (1354 ms)
```

`--json` 版（同一分钟第二跑，1354 ms，临时 home `/var/folders/jz/…/T/cl-realhost-kMWPCZ`）字段一致，`verdict: "PASS  real host activation"`。

同一脚本再验**已发布产物**（`DSH_REAL_HOST_SPEC=dsh-crash-lore@0.2.1`，真实从 registry 装 0.2.1 tarball，非本地 link，2026-10-29 00:20，退出 0）：

```
PASS  profile created from shipped template — exit 0, 112 ms
PASS  package installed (dsh-crash-lore@0.2.1) —  / Done in 253ms using pnpm v11.28.5
PASS  entry present in composed profile tree — line 385
PASS  loader activated the entry (no loader warning) — no activation warning
PASS  boot reached the credential wall (i.e. the tree mounted) — expected without a model key
PASS  apply() executed in the real host — boot scan logged
PASS  real host activation (2544 ms)
```

耗时在不同次跑之间为 1.2–3.0 s（差异来自 pnpm 解析与扫到的日志量，不是插件启动成本；探针总耗时含 3 次真实宿主调用）。

这一跑里 `apply()` 真正执行了 boot scan（打出 `[crash-lore] 新崩溃 3 条…`），比本地 link 那跑的 fallback 信号更硬；也顺手证明 registry 上的 0.2.1 与仓库 HEAD 行为一致。

注意：扫描会读真实 `~/Library/Logs/DeepSeek Harness` 并按产品的正常逻辑把新崩溃写进 `~/.dsh/crash-lore`（这是 boot scan 的预期副作用，桌面宿主下次 boot 也会做同样的事），probe 不改 profile、不改产品文件。

**这项证明什么**：0.2.1 的 `cordis.patch.yml`、`cordis` 元数据、`apply()` 在真实 loader / 真实 bundle 分层 / 真实 `tools` 服务下能装上且不报激活失败；`package.json` 的 bundle 声明与 patch 的 entry 名一致（否则合成树不会出现该 entry）。
**这项不证明什么**：没有模型交互，所以不覆盖真实会话里的 ① 拒绝文案与文件 sha 不变、③ 第二会话存活、④ PTC 回传、⑤ 三档切换。那几项仍要等 desktop 宿主重启后按第 5 节清单验，来源列继续写「无（未取得）」，不用本项替代。



### 第 10 项 真实宿主进程里的拦截决策（PASS，非 mock）

`node scripts/real-host-guard.mjs`（2026-10-28T16:23:13Z）→ 13/13 PASS，2.0–2.4 s，exit 0；原始 JSON 保存在 `/tmp/cl-guard-report.json`。

做法：临时 `DSH_HOME` + 出厂 headless 模板起一个真实宿主进程，除 0.2.1 外再装一个**临时 fixture 包**（`scripts/fixtures/guard-probe/`，不进 npm 产物）。fixture 等 `tools` 服务挂载后调用宿主自己的 `ctx.tools.execute()`（参数就是 `write` 的 `file_path` 与 `content`），于是走的是真实 `tools.guard` 链与真实拒绝载荷，而不是测试里手搓的 ctx。两个调用：正常建文件（应成功，验证不过度拦截）、把非法 JS 写进本仓库 `index.js`（应被拒）。

原始输出（节选）：

```
PASS  real host mounted the tree (stops only at the credential gate) — 1013 ms
PASS  fixture reached the real tools service — 2 call(s)
PASS  innocent write executed (no over-blocking)
PASS  dangerous write rejected by the live guard
PASS  denial came from this plugin, not another layer
PASS  denial names the rule and the reason
PASS  denial returns to the caller instead of crashing the host
PASS  denied file is byte-identical afterwards — 9428e512862b92cd → 9428e512862b92cd
PASS  no worker/loader crash during the probe
PASS real host process · 13/13 checks (2419 ms)
```

被拒调用拿到的是真实宿主回给调用方的载荷（节选）：`[CRASH_LORE_BLOCKED] 本次操作未执行。 插件：dsh-crash-lore 位置：/Users/apple/Desktop/DSH/dsh-crash-lore/index.js 规则：P013 文件语法不合法（写进去必然激活失败） 原因：Invalid or unexpected token 风险：… 建议：先修好语法再写进 live 插件 …`

**这项证明什么**：0.2.1 的 `tools.guard` 在真实宿主进程、真实 `tools` 服务、真实工具参数形状下确实运行并返回拒绝；拒绝文案带规则号、位置、原因、修复建议；被拒文件字节不变；同一进程里的正常写不受影响（不误伤）；拦截不杀掉宿主。
**这项不证明什么**：没有模型回合，所以不覆盖「拒绝回到**原会话**、该会话继续开发」（第 4 项）、真实 PTC 回传（第 5 项）、三档切换的第 6 项真机部分，以及重启后 `set_plugin` 在线重载；这些仍写「未覆盖 · 待重启宿主后验证」。
**探针自身的前提**：必须显式给 `DSH_PROFILE_DIR=<临时 profile>`，否则 live surface 判定为空，写 live 插件会被宿主的 read-before-write 策略先挡下，看到的是 `FS_NOT_OBSERVED` 而不是本插件的判定——探针因此显式注入该变量，避免把别人的拒绝记成自己的证据。


## 3. 附加项

| 附加项 | 判定 | 证据 |
|---|---|---|
| (a) 按 profile 隔离隔离记录（quarantine） | **PASS** | `e4-desktop-not-suppressed-by-work`：work profile 的坏记录不影响 desktop，desktop 命中 `quarantine dsh-bad (entry.profile=desktop)`；`e5` 旧全局记录两 profile 均生效 |
| (b) 事件数 >100 时计数仍真实（身份列表上限 100） | **PASS** | `e1-cap-truthful-count`：count=105、ids=100、lastTs=2026-10-05T08:00:00.000Z；`e2-force-rescan-no-growth`：强制复扫仍 105，不重复累加 |

命令：`node test/integration/extras.mjs` → 5 pass / 0 fail（`/tmp/cl-acceptance-extras.json`）。

## 4. 发布门禁汇总

| 门 | 结果 |
|---|---|
| `npm test`（`node --test test/*.test.mjs`） | 92 pass / 0 fail（A 新增 3 条防御回归） |
| `node cli.mjs check .` | exit 0，「预检通过」 |
| 严格矩阵 | 29 PASS / 0 FAIL / 0 XFAIL |
| 冷装 | 28/28 |
| extras | 5/5 |
| `node scripts/verify-0.2.1.mjs` | 6 pass / 0 fail（2026-10-28T16:01:40Z） |
| `test/integration/adversarial.mjs --strict` | 6 pass / 0 fail，exit 0（修复前为 exit 1，证据保留） |
| `node scripts/real-host-activation.mjs` | 6 pass / 0 fail 两次：仓库 link（00:15，1.2–1.4 s）、`dsh-crash-lore@0.2.1` registry 产物（00:20，2.5–3.0 s），真实宿主进程加载，非 mock |

| `node scripts/real-host-guard.mjs` | 13 pass / 0 fail（2026-10-28T16:23:13Z，2.0–2.4 s），真实宿主进程内对真实 `write` 调用做拦截决策，非 mock |
关键文件 sha256（产品冻结后 2026-10-29 00:02 采样）：`package.json fd2d7150…`、`index.js 9428e512…`、`guard.mjs 53baf07f…`、`defense.mjs f95e8c87…`、`state.mjs 7cb6f887…`、`lib/resolve.mjs 6778f718…`、`lib/judge.mjs f5a20752…`、`core.mjs e5279e46…`、`cli.mjs b0eda281…`。历史快照（A 修复前）：`index.js f57b8a0d…`、`defense.mjs 673d4986…`/`ea38322f…`（安装 fail-closed 前）、`guard.mjs c108aedf…`、`lib/judge.mjs 49ee359e…`。

## 5. 真机状态（待重启后验证，禁止写成已通过）

只读检查（2026-10-28 23:50、2026-10-29 00:02，未写入真实 profile）：

- 宿主 `pid 90362` 启动于 **17:28:53**；`defense.mjs` 最后修改 **2026-10-29 00:00:53**（安装 fail-closed 修复）、`guard.mjs` 23:55:20、`index.js` 23:55:09、`lib/resolve.mjs` 23:57:58。**这些都晚于宿主启动，当前进程加载的是改动前代码**，其行为不能作为 0.2.1 的真机验收证据。
- 是**同一个宿主进程**在 boot 时加载了当时的 `index.js`：boot 期间进程内 `crash_lore_guard` 曾能回「模式 开启 / 实际状态 正常 / 覆盖写前检查、安装前预检 / 最近一次检查 放行 → lead」；Config 目录显示 `absent` 是因为 boot 那份 0.2.0 没有导出 Config（0.2.1 才加），不是两个实例。
- **2026-10-29 00:10 复核，该 entry 现已 `fiberPhase: failed`、`crash_lore_*` 工具在本会话不可见，即当前宿主里防护是关的**（不是「装好了在跑」）。插件生命周期状态以 `plugin_manager list_plugins` 的 `include:crash-lore`（`enabled: true / fiberPhase: failed`）为准，不以旧文字记录为准。
- 00:12 尝试用合法通道 `plugin_manager set_plugin` / `set_bundle` 在线重载 0.2.1（先 disable 再 enable，各一次 + bundle 级各一次）：全部返回 `dsh: warning: 1 entry did not activate / crash-lore (dsh-crash-lore): Error: cannot create effect on inactive context`。同一报错在**与本插件无关**的操作里也作为 `adb (dsh-mobile-use)` 警告反复出现，说明这不是 crash-lore 的加载错误，而是**该宿主当前的动态 apply 通道整体不可用**（重新 apply 任何 entry 都会落在 inactive context 上）。结论：本会话内无法把 0.2.1 装上机，只能重启宿主。
- 重载尝试没有留下持久副作用：`cordis.patch.yml` 在 00:00 后未再变化（当前 sha256 `95da2c6c5d737d7172605ad9a004165d9e80410ff3eb15bf912ed9c81b106b67`，无 `crash-lore` 行、无 `disabled` override），profile 依赖仍是 `link:/Users/apple/Desktop/DSH/dsh-crash-lore`，entry `enabled: true`。故**重启后会按正常路径加载 0.2.1**，无需任何手工修复。注：本文件当前 sha 与 Lead 备份 `/tmp/patch.bak-lead` 已不同（差异只是 `- id: adb / disabled: false` 两行，`adb` 在本宿主同样 failed），本报告早前写的 `f7c3dcf3…` 与「逐字节一致」据此作废，**以 95da2c6c… 为准**。
- 00:15 补了一条**真实宿主进程**证据（见第 9 项）：0.2.1 在出厂启动器 + 临时 `DSH_HOME` + 出厂 headless 模板的真实 loader 下 6/6 激活，无 `did not activate`、合成树含 entry。这补上了「能不能被真实 loader 装上」一半，但**没有模型交互**，第 4、5 项的真实第二会话与真实 PTC 仍属未取得，判定不变。
- 00:23 又补一条真实宿主进程证据（见第 10 项）：真实 `tools.guard` 对真实 `write` 调用返回 `[CRASH_LORE_BLOCKED]`/`P013`，同进程的正常写成功，被拒文件 sha256 不变（`real-host-guard.mjs` 13/13）。这坐实了「拦截决策 + 拒绝载荷 + 不误伤 + 不杀宿主」半边；仍**没有模型交互**，同会话存活 / PTC 回传 / 三档切换 / 重启后 `set_plugin` 仍待重启。
- 待重启后补验（每项都要原始工具结果 + 时间，写进本文件，不通过就写哪一步失败）：① `plugin_manager list_plugins` 里 `include:crash-lore` 为 `fiberPhase: active`、`crash_lore_guard` 工具可见并报「保护中」且与真实 hook 一致；② 真实会话里危险 `write` 被拒且文件 sha256 不变，改正后同调用放行；③ 真实第二会话做同一动作，确认拒绝只回发起会话、该会话继续活着；④ 真实 PTC `run_code` 子调用被拒后原会话收到补充说明；⑤ guard/observe/off 三档切换与状态文本一致；⑥ 20 entry 预检耗时（批量解析后应 <200 ms）。
- 附带要观察的一条：重启后 `set_plugin` / `set_bundle` 的在线重载是否恢复可用（本轮它是坏的）。若重启后仍报 `cannot create effect on inactive context`，那是宿主侧缺陷，应单独报给宿主，不记在插件账上。

## 6. 结论与残留风险

- 功能面（第 1–6、8 项）在真实 handler / 真实 `apply()` 层面通过，0.2.0 的四个已知洞（相对路径、symlink、`set_bundle`、entry-id≠包名）已封；未解析目标 fail-closed。
- 第 7 项性能历史 FAIL（421–533 ms）已保留；A 的批量语法检查落盘后复测 **1.3 ms**（min），第 7 项转 PASS，自动门禁通过。若后续再改 `guard.mjs` 需重跑 c14，不能用本次数字覆盖历史。
- 真机拦截：**加载/激活半边（第 9 项，仓库 link 与 registry 产物各 6/6）与进程内 guard 决策半边（第 10 项 13/13：拒绝载荷、正常写不误伤、被拒文件 sha 不变、宿主不崩）已有真实宿主进程证据**；交互式半边（拒绝文案、第二会话存活、PTC 回传、三档切换）仍需 desktop 宿主重启后验证。当前运行中的进程仍是旧代码，不能把进程内 PASS 当成真机 PASS。
- 本报告所有 mock/进程内证据与真实宿主证据分开标注；真实第二会话、真实 PTC 本轮未取得，来源列保持「无（未取得）」，不冒充 Lead 补证。
- **第 3 项对抗用例已闭环**：修复前 20 个 1.5 MB 级 entry、坏语法、150 ms 预算时会 `unchecked:20` 且 ALLOWED（证据 `/tmp/cl-acceptance-adversarial-before.txt`：2 pass / 1 fail、exit 1）；A 改为安装/启用路径 3000 ms + 单次重试 + `uninspected` 硬拒后，同用例 deny P013，5 ms 预算注入 deny `uninspected`（文案不冒充语法错误），20 个大而合法入口 allowed。`adversarial --strict` 现为 6/6、exit 0。写前检查仍是 fail-open，符合「写前不因性能预算误伤」的原口径。

## 7. 文档自查

`node ~/.agents/skills/zh-ui-type-lint/scripts/zh-lint.mjs docs` → **0 error / 10 warning**；全部 `zh-dash` 都是 `node --check`、`--strict`、`--json`、`--test`、`--profile` 这类命令 token 的误判（第 9 项新增 4 条、第 10 项新增 1 条同因），非中文标点问题，按 Lead 口径不改命令写法、不加 `.zh-lint.json`（该脚本的 `ignoreRules` 在当前版本会因 `__ignored__` 查表崩溃）。
