# dsh-crash-lore · 崩溃防线

开发 DSH 插件时反复把 harness 修崩。这个插件把本机真实崩溃日志沉淀成一条闭环：

```
崩溃日志（黑匣子） → 归因条目 → 精简规则（lore） → 四条用法
                                     ├─ 每次会话注入提示词（预防）
                                     ├─ 导出到 dsh-lite-memory（跨会话记忆）
                                     ├─ 装插件前静态预检（拦截）
                                     └─ 起不来时自动停用元凶（自愈）
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

- `incidents.jsonl` — 归一化后的崩溃条目，按 fingerprint 去重
- `rules.json` — 规则库
- `state.json` — 已扫日志的 mtime、停用记录

日志来源：`~/Library/Logs/DeepSeek Harness/crash-*-host.log`、`crash-*-web-boot.log`、`$DSH_HOME/logs/startup-*.log`。
所有入库文本先脱敏（`sk-…`、`Bearer …`、`apiKey|token|secret|password=`）。

## 安全边界

- 只读日志，不改 DSH 安装目录；写盘只限 `$DSH_HOME/crash-lore/`。
- `doctor` 只改 profile 的 `package.json` 与 `cordis.patch.yml` 里对应那一行，改前 `*.bak-<ts>` 备份；解析失败就放弃，不留半写状态。
- 停用可撤销：`restore`，或手动把 `.bak-<ts>` 拷回。
- 静态守卫只在低误报写法上开（如 `process.exit(`、插件顶层 `await`），不对「回调里抛异常」这类做静态判定。

## 自愈怎么做到的

崩溃杀死了上一个宿主进程，日志留在磁盘上。下一次启动时本插件先跑一次扫描：
新日志 → 条目 → 元凶插件 → 若上次是致命崩溃且 harness 反复起不来，`doctor` 把该插件从 profile 停用并备份。同一指纹重复出现时条目上的 `count` 累加，`--auto` 以它判断「一次性」还是「崩溃循环」。
所以「自我阻止」不是拦截每一次崩溃，而是**同一形态的崩溃不会连续发生第二次**。

## 测试

```bash
node --test test/
```

`test/core.test.mjs` 用合成日志样本覆盖三种日志格式、去重、脱敏、规则匹配与预检。
