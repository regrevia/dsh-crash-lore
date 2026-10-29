# 0.3.2 验收：拦截不了的崩溃怎么补

0.3.0/0.3.1 把「写前检查」和「安装前预检」做实了。2026-10-29 这一轮连环崩溃暴露的是另一类：
代码已经装进去、在运行时崩的，写前检查看不到。0.3.2 补三件事——把堆耗尽归因到具体插件、
把重复崩溃判成崩溃循环、把内存曲线在活的时候记下来。

## 1. 事实基线（本机 crash 日志，未改写）

| 时间 (Z) | 形态 | 归因 |
| --- | --- | --- |
| 10-28 18:08:20 | stack-overflow · `scrcpy.js:1309` | `dsh-mobile-use`，有栈 |
| 10-28 21:40:08 | out-of-memory · heap 3770 MB | 日志无插件栈，原判 `core` |
| 10-28 21:57:11 | out-of-memory · heap 3724 MB | 同上 |
| 10-28 22:44:28 | out-of-memory · heap 3968 MB | 同上 |
| 10-28 23:01:47 | out-of-memory · heap 3987 MB | 同上 |
| 10-28 23:05:48 | out-of-memory · heap 4037 MB | 同上 |
| 10-28 23:13:09 | out-of-memory · heap 3861 MB | 同上 |

直接原因已由用户侧确认：`dsh-mobile-use` 的 `ScrcpyChannel` 清理路径重入，`closed → stop → closed`
无限递归到栈溢出；修复在工作树中（`_disposed` 幂等位），`node --test test/scrcpy.test.mjs` 55 项通过。
本节只处理另一半：**为什么防线没拦住，以及补什么才拦得住**。

## 2. 为什么 0.3.1 没拦住

- 写前检查（`tools/pre-execute` + 文件写守卫）只看**写入和安装**。已经装进 profile 的 `scrcpy.js`
  在运行时递归，没有任何可拦的写入动作。
- 安装前预检（`install-check`）只看 P001/P002/P005/P007/P008/P009/P010/P013/P014/P016/P018/P019/P021
  这些**可静态识别**的形态。`_dispose()` 重入不是语法错，也不是配置错，静态看是合法代码。
- 堆耗尽日志里只有 `app.asar/lib/main.js` 帧，`culpritFromFrame` 只能给出 `core:deepseek-harness`，
  插件名一次都不出现，所以 `crash_lore_heal` 的「同一元凶 24h ≥3 次」永远不触发。
- 结论：这是防线**覆盖边界**，不是回归。边界写进状态卡：「覆盖不到……已经装进去的代码在运行时崩」。

## 3. 0.3.2 加了什么

### 3.1 关联归因 `lib/attribute.mjs`

`correlateIncidents(incidents, { windowMs = 6h })`：堆耗尽行（`kind === 'out-of-memory'` 且 culprit
为 core）从**同一时段更早的插件崩溃**继承元凶，标 `inferred: true` 并保留
`inference { from, fromKind, fromSignature, gapMs, reason }` 与原始 `hostCulprit`。
已归因的行不动，重复扫描收敛不回退。

实测（真实 store，18 行）：

```
$ node -e "…scan({})…" 
correlated=0            # 第一次扫描已写入，重跑不再重复
dsh-mobile-use  count=8  inferredCount=6
  2026-10-28T09:15:33Z → 2026-10-28T23:13:09Z
```

6 条堆耗尽全部从 `core:deepseek-harness` 改为 `plugin:dsh-mobile-use（关联归因）`，
依据是同一次运行更早的 `stack-overflow · scrcpy.js:1309`。**这是推断，不是解析出来的事实**，
状态行和摘要都会写明「关联归因」。

### 3.2 崩溃循环 `crashLoops(incidents, { windowMs = 24h, min = 3 })`

同一元凶 24h 内 ≥3 次即判循环，给动作而不是给日志：
`崩溃循环 dsh-mobile-use 24h 内 8 次（…，其中 6 次按关联归因）→ 先 crash_lore_heal 停用再修`。
`crash_lore_scan` 与 `crash_lore_guard` 都输出这行。

### 3.3 堆内存观测 `watchdog.mjs`

被动采样（20 s 一次，`unref` 定时器，失败即丢，从不 `process.exit`、从不接管宿主关闭）：
`heapUsed/rss/peak/trendMBPerMin`，越过 2800 MB 记一条告警并持久化到
`~/.dsh/crash-lore/heap.jsonl`，重启后还能看到「上次运行到过 4037 MB」。

只做一件事：把「宿主突然没了」变成活着时的数字。它**不能**阻止 V8 堆耗尽。

## 4. 规则

| id | 标题 | 来源 |
| --- | --- | --- |
| R026 | 关闭路径要幂等：先置已销毁再 emit closed，否则 stop→closed→stop 无限递归 | 本次 18:08 栈溢出 |
| R027 | 同一插件反复把宿主带走：先停用再修，不要带着它重启 | 8 次/14h 循环 |

`seedRules` 改为每次启动合并：老 store 也能拿到新规则，命中数、`memoryId` 保留。

## 5. 验证

```
$ npm test
ℹ tests 157
ℹ pass 157
ℹ fail 0
```

新增 `test/attribute.test.mjs`（5 项：窗口内归因、窗口外不归因、幂等不链式、循环阈值、双次不算循环）
与 `test/watchdog.test.mjs`（5 项：趋势、临界告警、回落释放、采样失败不抛、环形缓冲有界）。

## 6. 仍然覆盖不到（写清楚，不假装）

- 已安装代码的运行时缺陷：无写入可拦，只能事后归因 + 循环提示。
- 堆耗尽本身：观测不阻止。真正的上限要宿主侧给（`--max-old-space-size` 或 worker 隔离）。
- 插件枚举：`ctx.tools` 没有 `list()`，宿主内枚举已装插件不可行；归因靠日志关联。
- 外部编辑器保存、命令行直接写文件、DSH 自身升级：写守卫看不到。

## 7. 附带修复

- `dsh-mobile-use`：`_dispose()` 幂等位 + 回归测试（工作树，55 项通过），本轮崩溃直接原因。
- 08:47 的两条 `desktop welcome: Web authentication failed` 属启动鉴权失败，与插件无关，
  已单列为独立形态，未并入本次改动。
