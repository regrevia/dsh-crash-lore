# 交接：dsh-crash-lore → dsh-guard（插件卫士）

写给下一个接手 dsh-guard 的会话。读完这一份就能开工，不必翻历史对话。

## 0. 一句话现状

`dsh-crash-lore` 已经是「一个包、四个板块」的插件卫士：崩溃归因与规则沉淀、装前静态预检、装后冲突体检、受控自愈，外加堆预警。装前体检原本是独立插件 `dsh-install-check`，已并入本包并从本机 profile 卸载；独立仓库与 npm 包停在 0.2.1，只作历史保留。下一步是把包改名成 `dsh-guard` 并把板块边界写死，**不是**再加新面。

## 1. 边界（写死，别扩）

做：只收**插件生命周期故障**——装不上、起不来、跑着跑崩、插件之间互相踩、配置/patch 冲突。

不做（用户明确否掉过）：
- 常驻文件监控、网络监控、进程/端口审计；
- 并 prompt 管理或记忆类插件（`dsh-lite-memory` 是正交领域，方向相反）；
- 改名后立刻做「安全扫描」类承诺（漏洞、权限、隐私），能力不匹配就是空头支票。

## 2. 现有模块

| 板块 | 入口 | 触发时机 | 开关 | 会不会拦 |
|---|---|---|---|---|
| 写前防护 | `defense.mjs`、`guard.mjs` | 会话中写文件/改配置 | `mode`（protect/observe/off） | protect 下拦 |
| 装前预检 | `cli.mjs` + `lib/judge.mjs`/`lib/resolve.mjs`、工具 `crash_lore_check` | 装之前、手动调用 | 无（只出报告） | 不拦，只报 |
| 装后体检 | `install-check/index.mjs` + `install-check/lib/*` | `tools/post-execute`，装包成功后 | `installCheck: false` 关 | 被动备注，不拦 |
| 崩溃归因 | `lib/attribute.mjs`、`memory.mjs`、`rules.seed.json` | 崩溃后：`crash_lore_scan` / `crash_lore_record` | 无 | 不拦 |
| 崩溃循环 | `core.mjs` 的 `crashLoops()` | 状态卡与自愈判断 | 无 | 不拦 |
| 堆预警 | `watchdog.mjs` | 20s 慢定时器采样（unref，best effort） | 无独立开关，随插件 | 不拦，只记 |
| 受控自愈 | `doctor.mjs`、工具 `crash_lore_heal` | 起不来时 | 无 | 只停用插件，不接管退出 |
| 状态卡 | `state.mjs` 的 `describeStatus` | 工具 `crash_lore_guard` | 无 | 不拦 |

工具共 7 个：`crash_lore_check` `crash_lore_export` `crash_lore_guard` `crash_lore_heal` `crash_lore_record` `crash_lore_rules` `crash_lore_scan`。
本包**没有 client 半**（`package.json` 只有 `dsh.bundle.patch`，无 `dsh.client`），所以改名不涉及 client factory ID；哪天加 client，再按「包名 = entry ID = factory ID」办。

## 3. 硬约束（动代码前逐条对）

1. **监听顺序是承重的**。`defense/guard` 的 `tools/pre-execute` 必须仍是第一个注册的；`install-check` 的激活必须留在 `crash-lore: ptc feedback` 这条 effect 之后（`index.js` 约 470–580 行）。顺序错了，装前预检会看不到被拦下的包，或出现重复监听。
2. **每模块独立 `try/catch`**。一个板块抛错只能让状态卡多一行错误，不能让整个插件起不来——这插件自己的教训就是「插件把宿主带走」。
3. **装前路径只有一条**，不做重扫描；install-check 有 25s 预算，加检查只能在预算内增量。
4. 被动监听不 `preventDefault`、不阻塞 `next()`；工具失败要自己兜住并如实返回三态（完成未发现冲突 / 完成发现问题 / 未完成）。
5. **改名不能只改包名**：`package.json` 的 `name`、`dsh.bundle.patch`、`cordis.patch.yml` 里的 `- id: crash-lore`、profile 的 `link:` 与 `bundles`、bin 名、`files`/`exports`、`locale/*.json`、`icon`、README、市场条目全部要一起动。
6. **新文件名要避开本机崩因规则**：`crash_lore_check <repo>` 会扫自己仓库，历史上 `client.*` 命中过 P020，才把 helper 改名 `bundle.mjs`。加文件先跑一次预检。
7. 仓库里不能出现本机绝对路径与凭据（`test/integration/cold-install.mjs` 的 p12 用例会查）。
8. 只跑 `node --test test/*.test.mjs` 与 `node cli.mjs check .`，别引入构建步骤；Node 用宿主自带：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`。

## 4. 配置与开关

当前 schema（`index.js` 约 98–107 行）就这么几个字段：`mode`（默认 `protect`，hot-reload 可改）、`home`、`promptChars`（默认 1000）、`guard`/`monitorOnly`（旧键，等价 `mode=off`/`observe`）、`installCheck`（默认 `true`）。

改名阶段不要动语义，只做迁移：
- 旧键继续认，新键可选；`mode: off` 关全部（含装前预检与装后体检）。
- `installCheck: false` 只关装后体检，其余照常。
- 状态卡措辞归 `state.mjs` 的 `describeStatus` 管，`guard.mjs` 不写文案；加板块就在状态卡加一行，别改别的行。

## 5. 改成 dsh-guard 的迁移清单

建议顺序（每步可独立回滚）：

1. **先出 dsh-guard 新包**，不改旧包：复制仓库为新仓库 `regrevia/dsh-guard`（保留 git 历史用 `git clone --mirror` 或直接在新仓库首次提交注明来源），`package.json` 改名，bin 改 `guard`，patch 文件 `cordis.patch.yml` 的 id 改 `guard`（**同一个 id 只能出现一次**）。
2. **本机切换**：profile 里把 `dsh-crash-lore` 的 `link:`/`bundles` 换成 `dsh-guard`，`rm` 旧软链；重启后跑 `crash_lore_guard`（未来叫 `guard_status`）确认状态卡正常、装前预检仍拦得住。
3. **旧包退役**：`npm deprecate dsh-crash-lore "已并入 dsh-guard"`，README 顶部写迁移说明；市场条目改成新仓库（新增 `regrevia__dsh-guard.yml`，旧条目请求下架）。
4. **不要**保留双份安装：profile 里同时装两个会重复注册 `tools/pre-execute`，这正是本插件天天警告用户的形态。
5. 工具名是否跟着改，二选一说明白：改就一次性改完（`crash_lore_*` → `guard_*`），并在 README/交接里列旧名映射；不改也行，但别一半一半。

## 6. 路线图（按需推进，别一次铺开）

- 0.4.x：**配置/patch 一致性**检查——重复 patch id、profile 装两份核心包、必填 config 缺失。塞进 `crash_lore_check`，不新增 hook。
- 0.5.0：**依赖与来源体检**——引擎版本、peer、安装脚本异常、tarball 与仓库不一致。要有真实踩坑样本再写规则。
- 改名 `dsh-guard` 单独一版，不和新板块混在同一次发布。
- 不做：常驻监控、漏洞扫描、prompt/记忆合并。

## 7. 当前发布状态

- 仓库：https://github.com/regrevia/dsh-crash-lore ，main HEAD `747619f`（0.3.3），CI 绿。
- npm：https://www.npmjs.com/package/dsh-crash-lore ，`latest = 0.3.3`。
- 市场：收录 PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10233 仍 OPEN，等维护者合并；合并前市场里只有旧的 `dsh-install-check` 条目。市场卡片版本来自上游 `dsh-plugin-catalog` 日构建，npm 发版后不用再提版本 PR，但**新收录条目**仍要 PR。
- 本机 profile：`~/.dsh/profiles/desktop` 只装 `dsh-crash-lore`（`link:` 到本地仓库），`dsh-install-check` 已从 `dependencies`/`bundles`/`node_modules` 移除；`cordis.patch.yml` 只有一处 `- id: crash-lore`。
- 独立仓库 `regrevia/dsh-install-check` 与 npm 0.2.1 停在历史版本，README 已注明并入。

## 8. 下一个会话的第一批动作

1. `git -C <repo> status` 确认干净、`node --test test/*.test.mjs` 157 条全绿、`node cli.mjs check .` 预检通过。
2. 跟用户确认改名窗口（是否需要保留旧包一个版本过渡、工具名改不改）。
3. 按第 5 节第 1 步开新仓库与 `dsh-guard` 包骨架，先只改名不加功能；本地 `link:` 进 profile 验证状态卡与预检。
4. 验证通过再谈 0.4.x 的配置一致性板块。
5. 发版仍走四步：开源 main、npm、市场、生效验证，回报要带 GitHub / npm / 市场 PR 三条绝对链接和版本号。

## 9. 验收门（每次改完都跑）

```sh
cd <repo>
node --test test/*.test.mjs          # 期望 157 通过 0 失败
node cli.mjs check .                 # 期望「预检通过」
```

装进 profile 后：`crash_lore_guard` 状态卡应出现「模式 开启 / 实际状态 正常 / 安装体检 开 … / 覆盖范围 写前检查、安装前预检」；host 半改动只能重启应用，client 半优先热刷新。

## 10. 文件索引

- `index.js`：`apply`、配置、7 个工具注册、install-check 激活点。
- `state.mjs`：`describeStatus`（所有状态文案都在这里）。
- `defense.mjs` / `guard.mjs`：写前拦截；`install-check/index.mjs`：装后体检模块（ESM，自带 disposer）。
- `lib/attribute.mjs`：崩溃关联归因；`core.mjs`：`VERSION`、`crashLoops()`、存储路径。
- `watchdog.mjs`：堆采样（定时器 unref，绝不抛）。
- `doctor.mjs`：受控自愈；`memory.mjs`：规则读写。
- `docs/ACCEPTANCE-0.3.0.md`、`docs/ACCEPTANCE-0.3.3.md`：每次真崩溃的验收记录，新规则从这里长出来。
- `test/host.test.mjs`：假宿主，`ctx.effect` 顺序决定监听顺序，改顺序先看它。
