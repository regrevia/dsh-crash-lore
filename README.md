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
| 装之前先跟已装的比一遍 | 工具调用后被动备注（重名 / 缺依赖 / 版本 / skill 撞车 / 功能重叠），不拦安装；`config.installCheck` 默认开 |
| 运行中拦截危险改动 | 见「崩溃防护」一节；状态与拦截记录用工具 `crash_lore_guard` |
| 导出清单 | 工具 `crash_lore_export`（默认只在对话里给 markdown；`target:'memory'` 才写长期记忆 global 层） |
| 起不来时自愈 | 工具 `crash_lore_heal` / CLI `doctor` |
| 大会话转世 | 工具 `crash_lore_handoff`（读懂原会话写交接单，新会话接手，原会话归档） |
| 查转世血缘 | 工具 `crash_lore_lineage` |
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

## 崩溃防护（运行中拦截）

预检是装之前问一次，防护是在副作用发生之前每步都问：**这次调用会不会让正在跑的宿主起不来。**

两层接在宿主自己的执行链上：

| 层 | 宿主机制 | 管什么 |
| --- | --- | --- |
| 写前守卫 | `ctx.tools.guard()`（同步，不可被放宽） | `write` / `edit` 把**写入后的完整文本**交给规则检查；`bash` 只拦对 live 插件目录的整体删除/移动 |
| 安装前预检 | `tools/pre-execute`（异步 waterfall，`next()` 放行） | `plugin_manager` 的 `install_bundle` / `set_plugin(enabled)`：先解析候选目录，跑完整 preflight，再决定是否执行 |

live 面 = profile 目录本身 + profile 里所有插件源码（含 `link:` 的开发树，因为宿主就是通过软链加载它的）。

判据是「已经证明会让本机崩溃的形态」，不是风格问题：

- 模块顶层 `throw` / 裸 `await`（P014/P015）
- ESM 里 `require`（P016）、`__dirname`/`__filename`（P017）
- 插件 `process.exit`（P018）、接管 `SIGINT`/`SIGTERM`（P019）
- patch 重复 id（P009）、patch 引用的包没声明（P010）、包结构缺失（P001/P002/P005/P007/P008）
- 装前还有 `node --check` 的语法闸（P013）、`tools.register` 没闭合（P021）
- 配置里写明文凭据

放行：读文件、看日志、搜索、改不相关项目、改开发副本、跑测试、以及 live 插件里**正常**的改动（加函数、改文案、调参数）。宁可漏拦，也不拦正常开发——被拦的会话必须能继续改自己的代码。

拒绝时返回给**发起调用的那个会话**（不另开修复会话、不广播、不停用开发中的插件）：

```
[CRASH_LORE_BLOCKED] 本次操作未执行。

插件：dsh-inner-browser-use
位置：/…/dsh-inner-browser-use/index.js:312
规则：P018 插件调用了 process.exit
原因：插件进程里调 process.exit 会直接杀掉宿主，所有会话一起掉线
证据：process.exit(1);
风险：这一步会在 running profile 里生效，宿主激活/热重载时崩溃，当前所有会话一起掉线。
建议：改成抛给 ctx 报错或返回失败结果，让加载器决定是否停用
改好后重新提交这次写入；你仍可以继续读代码、改开发副本、跑测试。
```

工具结果就是一次普通的报错，会话照常继续 —— 修完再提交同一个调用就通过。

## 安装体检

`dsh-install-check` 已并进这个插件：`plugin_manager` 装包时先跟已经装好的比一遍，装完把「撞了什么名、缺什么依赖、版本够不够、skill 有没有撞车、和谁在做同一件事」写成一条备注，随工具结果回到会话。它只加备注，从不让安装失败；读不到目标就静默跳过。

开关：`config.installCheck`，默认开；`mode=off` 时一并关闭。三种结果写在备注里：完成未发现冲突 / 完成发现问题 / 检查未完成（25 秒预算）。

同一件事、两个名字也算重叠：两个包一个注册 `memory_save`、另一个 `memory_recall`，名字不撞，但都在做记忆。这类「功能重叠」单独一条建议（同一处界面、同一类能力），只在装/启用时给一次，`config.overlapCheck`（默认开）可单独关掉，不影响重名与依赖检查。

名字只是猜，实现才是证据：装之前还会用装前预检同一套规则读一遍候选源码，只报「一激活就可能带走宿主」的那类写法（顶层 throw / 顶层裸 await / `process.exit` / 接管退出信号 / patch 引用没声明的包……），带文件和行号与改法，最多两条。规则分两层：随包发的种子规则，加上这台机器从自己崩溃日志里学到的规则——谁的机器上学到，就守在谁的安装动作前。静态读文本，不执行、不联网；运行期才出现的竞态不在其中。开关 `config.implCheck`（默认开）。

开关：插件设置里选「开启 / 仅监测 / 关闭」三档，存进 `config.mode`；老配置里的 `guard: false`（关闭）、`monitorOnly: true`（仅监测）仍然认。仅监测用于先观察误报，只记录不拦。

状态别听它自己说：`crash_lore_guard` 按实际接上的层报 `保护中 / 仅监测 / 部分覆盖 / 检查异常 / 已关闭`，并说明哪一层没接上（例如宿主没有 tools 服务时直接报 `不可用`，不会冒充保护中）。

插件本身没被加载时没有东西能回答你 —— 这种情况不会显示成 `保护中`：宿主插件列表里该入口会标 `inactive`/`absent`，`crash_lore_guard` 工具也根本不存在。安装或升级后要重启一次宿主才会接上；改完插件源码最好先跑 `node cli.mjs check .`，语法/契约错误会让加载器直接停用入口，防护随之整层消失。

**覆盖边界**（照实写在状态里，不假装全覆盖）：bash/脚本里 `cat > file`、`run_code` 里自己 `fs.writeFile`、外部编辑器保存、宿主自身升级，都绕过工具管线，这层看不到。

## 化龙妙法：大会话转世

会话越长，恢复越贵——一个大会话恢复时要几 GB 堆，本机就是这么崩的。转世不解救旧会话，而是把活交给一个新会话：读原会话记录、写一份交接单、建新会话、把旧会话归档（不删，可取消归档回看）。

交接单默认**由模型读懂原会话再写**：给了它七节模板（目标 / 结论 / 走不通的路 / 改动 / 未完成与下一步 / 风险与注意），要判断不要复述日志，最值钱的是「走不通的路」——新会话不用把失败方案再踩一遍。转世允许比平时多花一点额度，因为丢信息的代价更高。

四条硬约束，保证转世本身不会成为新的崩溃点：

- 只调一次模型，输入有字节上限、输出有字数上限、整次调用有超时；原会话再长也只留最近的记录，但最早那条需求单独保住。
- 堆到 85% 就不调模型了，直接退回自动摘要（只摘记录，不做判断）。整理交接单不该再占一大块内存。
- 模型报错、超时、返回空、非正常收尾，一律退回自动摘要——转世不会因为整理失败而失败，结果里会说清用的是哪种。
- 交接单末尾固定让新会话先只回「收到」，免得一转世就当场再开重活，把刚空出来的内存立刻填回去。

`llm: false` 可关掉模型整理，只做自动摘要（省资源，丢判断）。原会话还在跑时拒绝转世（两个会话会同时写同一份工作，旧回合还会在归档后被腰斩）；确认它停下了，或 `force: true` 强行。内存只有重启才拿得回来：重启前新会话可能有一个未完成回合，重启后打开再发一句「继续」。血缘记在 `$DSH_HOME/crash-lore/lineage.jsonl`，改标题也不会丢，链式转世靠它串起来。

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

`test/core.test.mjs` 用合成日志样本覆盖三种日志格式、去重、脱敏、规则匹配与预检；`test/defense.test.mjs` 覆盖目标解析、危险写法与放行反例；`test/host.test.mjs` 用假宿主跑三档模式、热重载、PTC 子调用与原会话回传；`test/integration/matrix.mjs` 是真实宿主姿态的端到端矩阵，`cold-install.mjs` 用 `npm pack` 出的 tarball 冷装后启动验证。
