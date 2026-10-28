# corpus — 真机上真实发生过的 DSH 崩溃

这份目录不是示例数据。每一条都能指回本机磁盘上的一个文件，或一份会话记录里的原始日志文本。
采集只读，不改任何宿主文件；`~/.dsh/.credentials.yaml` 一类凭据文件没有读进语料。

## 目录内容

| 文件 | 内容 |
|---|---|
| `incidents.normalized.jsonl` | 5 条去重后的 Incident，严格按 `CONTRACT.md` 的 Incident 字段，`source` 只用契约里的三个枚举值 |
| `observations.jsonl` | 6 条同源但不是"崩溃 artifact"的观测（渲染进程 console、热重载日志、会话隔离、外部佐证），id 前缀 `obs_`，不喂给 core 也可用 |
| `artifacts.manifest.json` | 本机扫到的每一个 artifact：路径、字节、mtime、类型、它到底是什么、解析成了哪条事件 |
| `hits.sidecar.json` | 每条事件命中几次、命中哪些文件、去重理由、纠正过哪个上游 bug |
| `rule-evidence.json` | 规则 → 证据 id 的反查表（`inc_*` / `obs_*`） |

## 指纹与 id 的算法（core.mjs 必须一致）

```
fingerprint = sha256(`${kind}|${signature}|${frame}`).hex.slice(0,12)
incidentId  = "inc_" + fingerprint
```

- `kind` 取 Incident.kind 的枚举值；
- `signature` 是归一化后的签名（例：`TypeError · this.holding is not a function`），不是原始 message；
- `frame` 是**肇事帧**（`文件:行`，不带绝对路径前缀），不是整个 stack——否则同一 bug 换 shell pid 就会变新事件。

同一指纹的多份 artifact 只留一条 Incident，`artifact` 指向最新的一份，命中数进 `hits.sidecar.json`。这条规则在本机 10 份 crash 日志上验证过：5 份 → 1 条，5 份 → 1 条。

## 扫到的 artifact 与它们实际是什么

`~/Library/Logs/DeepSeek Harness/`（10 份，全部 2026-10-28 17:15–17:23 本地时间）

| 文件 | 字节 | 是什么 |
|---|---|---|
| `crash-2026-10-28T09-15-33-952Z-host.log` | 8083 | 信息最全的一份：host 崩溃头 + `--- error ---` + `--- renderer console (error level, oldest first) ---`。同时含 09:15:33 的 holding() 致命崩溃和 4 类渲染层信号 |
| `crash-…09-22-59-969Z-host.log` | 1540 | holding() 致命，无渲染 console 段（"no error-level renderer console output was captured"） |
| `crash-…09-23-08-782Z-host.log` | 1540 | 同上，四连崩第 2 次 |
| `crash-…09-23-15-612Z-host.log` | 1466 | 同上，第 3 次（字节差异只在 stderr 后缀） |
| `crash-…09-23-22-876Z-host.log` | 1540 | 同上，第 4 次；作为该事件的 canonical artifact |
| `crash-…09-15-39-953Z-web-boot.log` | 636 | web boot 失败（dsh-vantage 客户端入口没激活） |
| `crash-…09-15-46-268Z-web-boot.log` | 636 | 同上，7 秒后重试 |
| `crash-…09-16-46-295Z-web-boot.log` | 636 | 同上，1 分钟后 |
| `crash-…09-18-43-516Z-web-boot.log` | 636 | 同上 |
| `crash-…09-19-47-843Z-web-boot.log` | 636 | 同上，最新一份，作为该事件 canonical artifact |

`~/.dsh/logs/`

| 文件 | 字节 | 是什么 |
|---|---|---|
| `startup-2026-10-24T10-32-46.923Z-38966271-…c59c.log` | 7104 | profile `bench` 启动日记：失败插件表（agent-default-model 的 `$.provider` 缺失）、等待服务表（headless-runner → agentDefaultModel）、完整校验栈 |
| `chat-link-actions.log` | 98304 | dsh-chat-link-actions 的普通流水日志，没有崩溃形状 |
| `video-preview.log` | 0 | 空文件 |

`~/.dsh/unlag-reload.log`（284672 B）— dsh-unlag 热重载日志。没有插件激活失败；有热重载后的 client revision 失配、6 次 `the press was answered as failed and the page never said what it did`。

`~/.dsh/sessions/**`（2478 个会话目录，zstd 压缩）
- 只有 `--Users-apple-Desktop-odd-dsh-mobile-use--` 下的两份会话还留着 2026-10-27 的崩溃原文（原始 `crash-*.log` 已被轮转掉）。这是 `this.killStale is not a function` 唯一存证。
- 会话文件是 `session.v4.jsonl.zstd`，**纯文本 grep 永远搜不到**，必须 `zstdcat`；会话目录名是路径编码的。

`~/.dsh/sessions-quarantine/2026-10-25-Pet/` — 2 个会话目录被移出主库（读不出来时隔离而不是删除）。

`~/Library/DiagnosticReports/` — 没有 `DeepSeek*` / `Electron*` / `node` 的原生崩溃报告。**本机没有原生崩溃实例**，native-crash 类计数为 0。

`~/.dsh/profiles/desktop/cordis.patch.yml`（10599 B）+ 5 份 `.bak-*` — 配置侧证据：同一个 `- id:` 出现两次（`ui-chat` 99 行与 180 行、`remote-web-ui` 9 行与 208 行）；`insert:` 了带 `~` 绝对路径的 `file://` 插件；凭据走 `apiKeyEnv`（正确写法）。

## 采集器要解析的三件事

1. **crash 日志是扁平 header + 分段正文**：`time/source/phase/app/platform/electron/node/locale/shell pid` 逐行 `key: value`，然后 `--- error ---`，再可选 `--- renderer console (error level, oldest first) ---`。文件名里的时间戳和 header 的 `time:` 可能差几十毫秒，**以 header 为准**。
2. **startup 日志不是 JSON**：它是对象 dump（单引号、`[Getter/Setter]`、跨行 stack），用宽松的括号扫描/字段抽取，别 `JSON.parse`。
3. **`source` 由文件后缀决定**：`-host.log → host-crash`、`-web-boot.log → web-boot-crash`；`~/.dsh/logs/startup-*.log → startup-diag`。web boot 的失败是渲染层经 `DESKTOP_IPC.bootFailed` 上报的（宿主壳 `reportFatal(err, "web-boot")`），宿主进程本身还活着。

## 红线

- 复制任何文本前先遮掉凭据：本语料不含任何 token 值，配置证据只保留环境变量名。
- `~/.dsh/.credentials.yaml`、`remote-web-ui-devices.json`、`tinyfish.key.bad` 一律不读。
- 会话文件 compressed，不要为了 grep 全量解压 2478 个会话。
