# dsh-crash-lore · 崩溃防线

开发 DSH 插件时反复把 harness 修崩。这个插件把本机真实崩溃日志沉淀成一条闭环：

```
崩溃日志（黑匣子） → 归因条目 → 精简规则（lore） → 四条用法
                                     ├─ 每次会话注入提示词（预防）
                                     ├─ 导出到 dsh-lite-memory（跨会话记忆）
                                     ├─ 装插件前静态预检（拦截）
                                     └─ 起不来时停用元凶（自愈，需手动/循环确认）
```

## 装了什么

| 能力 | 入口 |
| --- | --- |
| 提示词里常驻一段精简约束 | systemPrompt 段 `crash-lore: rules`，默认 ≤1000 字符，按 fatal/boot/lint 排序 |
| 扫描崩溃日志 | 工具 `crash_lore_scan` |
| 查规则 | 工具 `crash_lore_rules` |
| 沉淀新规则 | 工具 `crash_lore_record` |
| 装前预检 | 工具 `crash_lore_check`（包结构 / patch / 工具注册契约 / ESM 语法 + 本机规则） |
| 导出清单 | 工具 `crash_lore_export`（默认只在对话里给 markdown；`target:'memory'` 才写长期记忆 global 层） |
| 起不来时自愈 | 工具 `crash_lore_heal` / CLI `doctor` |
| 宿主起不来时也能用 | `node cli.mjs ...`（不依赖 DSH 进程） |

## CLI

```bash
cd ~/Desktop/DSH/dsh-crash-lore
node cli.mjs status                 # 规则/条目/已扫日志数
node cli.mjs scan                   # 扫描新日志并归因
node cli.mjs rules                  # 规则清单
node cli.mjs prompt --chars 900     # 注入的那段正文
node cli.mjs check <插件目录>        # 装机前预检，命中即 exit 1
node cli.mjs export                 # 只打印清单
node cli.mjs export --memory        # 写进长期记忆 global 层（会进召回，慎用）
node cli.mjs doctor                 # 只看计划
node cli.mjs doctor --yes           # 停用元凶（先备份，可 restore）
node cli.mjs doctor --auto          # 只在确认崩溃循环（24h 同元凶 ≥3 次）时停用
node cli.mjs restore <包名>          # 撤销停用
```

## 存储

默认 `$DSH_HOME/crash-lore/`（本机 `~/.dsh/crash-lore/`）：

- `incidents.jsonl` — 以 fingerprint 归并的崩溃条目：`occurrenceTimes` 保留每次发生的时间，`count` 是真实发生次数
- `rules.json` — 规则库
- `state.json` — 已扫日志的 mtime、停用记录

日志来源：`~/Library/Logs/DeepSeek Harness/crash-*-host.log`、`crash-*-web-boot.log`、`$DSH_HOME/logs/startup-*.log`。
所有入库文本先脱敏（`sk-…`、`Bearer …`、`apiKey|token|secret|password=`）。

## 安全边界

- 只读日志，不改 DSH 安装目录；写盘只限 `$DSH_HOME/crash-lore/`。
- `doctor` 只改 profile 的 `package.json` 与 `cordis.patch.yml` 里对应那一行，改前 `*.bak-<ts>` 备份；解析失败就放弃，不留半写状态。
- 停用可撤销：`restore`，或手动把 `.bak-<ts>` 拷回。
- 静态守卫只在低误报写法上开（如 `process.exit(`、模块顶层 `throw`、真实脱离 ESM 的 `require`）；`createRequire()` 与函数体里被 try/catch 兜住的 `throw` 不报。

## 自愈怎么做到的

崩溃杀死上一个宿主进程，日志留在磁盘上。下一次启动时本插件先跑一次扫描，把新日志变成条目并归因到元凶插件——**启动阶段只记录，不自动改 profile**。

真起不来时用 `node cli.mjs doctor` 看计划、`--yes` 执行；`--auto` 只在确认崩溃循环时执行。停用前先备份 `package.json` / `cordis.patch.yml`，中途写失败会回滚已改文件，`restore <包名>` 可撤销（只注释过 patch 的隔离也能恢复）。

同一指纹每次发生都会记进 `occurrenceTimes`，`--auto` 按 24 小时窗口内的真实事件数判断「一次性」还是「崩溃循环」，不拿历史累计次数充数。

所以「自我阻止」不是拦截每一次崩溃，而是**同一形态的崩溃不会连续发生第二次**——代价是有一次手动执行的 doctor/heal。

## 测试

```bash
npm test               # node --test test/*.test.mjs
node cli.mjs check .   # 用本插件的守卫预检它自己
```

`test/core.test.mjs` 用合成日志样本覆盖三种日志格式、去重、脱敏、规则匹配与预检。
