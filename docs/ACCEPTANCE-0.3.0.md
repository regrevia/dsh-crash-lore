# 0.3.0 验收记录

时间：2026-10-28T21:46Z · 机器：darwin arm64 · node 24.21.0 · 仓库 `<repo>` · 基线 `78d303b`（0.2.1 之后）

本轮处理的是最近一次真实崩溃（`crash-2026-10-28T18-08-20-844Z-host.log`）暴露的三个缺口：**归错因、不算规则、说没崩**。另含已并入的安装体检（`install-check/`）。

## 1. 崩溃归因：`unknown · main.js:3845` → `stack-overflow · scrcpy.js:1309`

崩溃形态是 `Exception in PromiseRejectCallback: file:///…/scrcpy.js?v=11:1309` + `RangeError: Maximum call stack size exceeded`。旧解析只认宿主停止帧，把内部递归点丢了。

同一份真实日志，隔离 home 重放（`scan({home:'/tmp/cl-s8/home',dirs:['/tmp/cl-s8/logs']})`）：

```
{"harvested":1,"added":1,"unknown":0,
 "rows":[["stack-overflow","stack-overflow · scrcpy.js:1309","scrcpy.js:1309","dsh-mobile-use",["R013","R024"]]]}
```

- `kind` 从 `unknown` 变为 `stack-overflow`；
- `frame` 从 `main.js:3845`（宿主停止处）变为 `scrcpy.js:1309`（真正递归点）；
- `culprit` 为 `dsh-mobile-use`（此前为 `deepseek-harness`）；
- `?v=11/12/13` 归一化：热重载三次算同一条（单测断言两条日志 fingerprint 相等），不再把一个 bug 拆成三条。

## 2. 新规则 R024

`Maximum call stack size exceeded` → 「递归必须有终止条件，栈溢出会直接杀宿主」，severity `fatal`。上面重放已命中（`ruleIds` 含 R024，`unknown` 为 0）。

## 3. 扫描文案不再说「没有新的崩溃日志」

`crash_lore_scan` 在 `harvested=0` 且库里有条目时改报最近一条（时间、签名、证据路径）。原始误报场景：崩溃发生在 02:08，宿主 05:38 重启时 boot 扫描已入库，之后手动 scan 只回「没有新的崩溃日志」——机器刚死过却看不出来。现在同一状态回：

```
没有未解析的日志。最近一条：stack-overflow dsh-mobile-use · …（证据 ~/Library/Logs/DeepSeek Harness/crash-…-host.log）
```

二次扫描的原始返回：`second {"harvested":0,"added":0} incidents 1`。

## 4. 安装体检（随本轮并入）

`plugin_manager` 装包时比对已装项（重名 / 缺依赖 / 版本 / skill 撞车），以被动备注随工具结果回会话，**从不拦安装**；`config.installCheck` 默认开，`mode=off` 一并关。三种结论：未发现冲突 / 发现问题 / 检查未完成（25 s 预算）。

## 5. 套件

```
npm test           tests 145  pass 145  fail 0   duration ≈1.4 s
npm run check      预检通过：. 没有发现会导致崩溃或激活失败的形态。
```

新增/更新用例：`test/core.test.mjs`（stack-overflow 归因、缓存参数归一）、`test/install-check.test.mjs`（体检全套）、`test/host.test.mjs`（pre-execute 两个 listener：防线 + 体检）。

## 6. 本轮没覆盖什么

- 这类崩溃是**已在运行的 client JS 的运行时递归**，没有危险写入可拦；静态预检天然管不到。防线能做的是 `doctor` 自愈、规则沉淀、下次写类似代码时注入约束——不是「提前拒绝」。
- 桌面宿主需重启才加载 0.3.0；`crash_lore_guard` 在旧进程上仍报旧版行为。
- 运行时防护的 2 s 表面刷新只有在进程内验证（`c-*` 证据），活宿主重载窗口仍是已记录的残余风险（见 `ACCEPTANCE-0.2.1.md` §6）。

## 7. 0.3.1 补记：还有第二次崩溃，而且是另一种死法

发 0.3.0 时 `crash-2026-10-28T21-40-08-215Z-host.log` 才被注意到——比 18:08 那次更晚、形态也不同：`Error: dsh desktop host stopped: <--- Last few GCs --->`，GC 反复 scavenge 失败，进程在 ~3.7 GB 堆上被直接结束（shell pid 75411 / node pid 75480）。0.3.0 的解析器对它仍回 `unknown · Error: dsh desktop host stopped: <--- Last few GCs --->`，等于「又不知道是什么」。

修法与栈溢出同路：`classifyCrash` 认 GC 日记与 `JavaScript heap out of memory` / `FATAL ERROR: … Allocation failed`，新 kind `out-of-memory`；签名取 GC 行括号里的提交堆上限（`Scavenge 3701.7 (3758.6) -> …` 的第二个数），规则库加 **R025**「堆内存要有上限：缓存和无界队列会走 OOM，进程直接没了」。

同一份真实日志重放：

```
{"kind":"out-of-memory","sig":"out-of-memory · heap 3770 MB","frame":"main.js:3845"}
```

套件：`tests 146 / pass 146 / fail 0`，`cli check .` 预检通过。

两次崩溃的边界要说清：栈溢出能指到 `dsh-mobile-use/scrcpy.js:1309`；堆耗尽只能指到 `main.js:3845`——V8 不告诉你谁把内存吃光，`culprit` 因此是宿主进程本身，不是某个插件。这类崩溃同样**没有可拦的写入**，防线能做的是记录准确、给出「查内存上限」的方向，以及在写插件时把「缓存设上限」注入约束。
