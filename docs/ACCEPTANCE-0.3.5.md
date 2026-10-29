# 0.3.5 验收：大会话占用可见

## 1. 事实基线（本机 2026-10-29 09:29:47 崩溃）

- 日志 `crash-2026-10-29T01-29-47-822Z-host.log`：pid 79732，运行 2,293,635 ms（38.2 分钟）。
- 崩前 `3888.6 (3947.5) -> 3874.2 (3953.6)` / `3901.5 (3960.3) -> 3885.5 (3963.4)` MB，随后
  `FATAL ERROR: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory`。
- 栈全部落在 `app.asar/lib/main.js`，renderer 侧 `(no error-level renderer console output was captured)`：
  没有任何插件栈，不是某个插件抛异常。
- 重启后新宿主 pid 91126：`heap.jsonl` 09:30:56 → 3170 MB、09:31:56 → 3365、09:32:56 → 3433；
  `ps` 5 分 25 秒 RSS 3,234 MB，6 分 37 秒回落到 569 MB。是**启动瞬间的尖峰**，GC 能回收，不是持续泄漏。

## 2. 判定

启动时宿主把新近会话逐个恢复/索引，峰值由「被碰过的大会话总量」决定：

| 会话目录 | 压缩 | 明文 |
|---|---|---|
| `2026-Envoy` | 89 MB | 312 MB |
| `Desktop-DSH`（本会话） | 67 MB | 238 MB |
| `work-Pet` | 57 MB | 204 MB |
| `work/Studio-creator-studio` | 58 MB | — |

09:30:0x–09:30:34 之间 21 个会话锁被同一轮触碰，压缩合计 547 MB。历史 7 次 OOM 的 uptime
（86 s / 214 s / 436 s / 6.5 min / 17 min / 38 min / 75 min）与固定速率泄漏不符，与「尖峰落在恢复、
切会话、压缩重写的时刻」一致。

## 3. 新增能力

- `lib/sessions.mjs`：只读扫描 `$DSH_HOME/sessions`，按会话锁新鲜度（`LOCK_FRESH_MS = 15 min`）区分
  「宿主刚碰过」与「旧锁」；换算 `packed → 堆` 的系数 `RESTORE_FACTOR = 6.2`，由本机实测标定
  （547 MB 压缩 ≈ 3.3 GB 估算，实测峰值 3.2–3.4 GB）。
- 输出接在 `crash_lore_guard` 与 `crash_lore_scan`：一行列出最大的 3 个会话、总量与估算堆，并单列旧锁数量。
  实测输出：`宿主刚碰过 21 个会话（2026/Envoy 89 MB、Desktop/DSH 67 MB、…）：恢复时约占 3.3 GB 堆，用不到的先关。`
- 阈值 `ceilingRisk`：估算 ≥ 2 GB 才提示，空闲机器不刷屏。
- 只读：不关会话、不截断、不删记录；旧锁只计数不清理。

## 4. 规则

`R028 大会话恢复会瞬间吃掉数 GB 堆：一次只恢复一个，用完重启清堆`（seed 规则，`guard: null`）。

## 5. 测试

`npm test` → **162 pass / 0 fail**（新增 `test/sessions.test.mjs` 5 项：新鲜锁/旧锁、无锁文件、
风险阈值、目录缺失、文案与旧锁计数）。

## 6. 边界

- 插件拿不到堆分配、也释放不了；4 GB 是宿主 V8 默认上限，插件改不了。真正根治在宿主侧：
  限制冷启动恢复的会话数，或让 heap cap 可配置。
- 压缩包与堆死亡之间的换算依赖本机样例，换机器需重新标定——文档写的是系数和依据，不是普适常数。
- 栈溢出这条线已沉淀为规则 R026，签名不再绑定具体模块名，改成 `Maximum call stack size exceeded`：
  遇到栈溢出先查「关闭/清理路径有没有置位就 emit、emit 又回头调关闭」，再看递归有没有终止条件。
  这条规则对任何会转发外部进程关闭、或 stop/close 双入口的模块都成立，不依赖某个插件。
