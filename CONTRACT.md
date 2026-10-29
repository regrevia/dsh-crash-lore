# dsh-lifeguard — internal contract (v1)

Purpose: harvest DSH crash artifacts → normalized incidents → compact guard rules ("lore") →
inject as agent constraints + export to dsh-lite-memory + preflight-check plugin code.

## Artifacts harvested (read-only)
- `~/Library/Logs/DeepSeek Harness/crash-*-host.log`      (macOS desktop host crash; source=`host-crash`)
- `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`  (source=`web-boot-crash`)
- `~/.dsh/logs/startup-<iso>-<uuid>.log`                  (source=`startup-diag`)
- Linux/other fallback: `$DSH_HOME/logs/`, `~/.config/dsh/logs/` — best effort.

## Store (owned by core.mjs)
Dir: `$DSH_HOME/lifeguard/` (default `~/.dsh/lifeguard/`)
- `incidents.jsonl` one incident per line
- `rules.json` `{ "version": 1, "rules": [Rule...] }`
- `state.json` `{ "scanned": { "<abs artifact path>": <mtimeMs> }, "quarantine": [QuarantineEntry...] }`

### Incident
```json
{
  "id": "inc_<12hex>",
  "ts": "ISO",                       // artifact timestamp
  "source": "host-crash|web-boot-crash|startup-diag",
  "phase": "running|boot",
  "app": "0.2.1|null",
  "profile": "desktop|null",
  "kind": "uncaught-exception|plugin-activation|config-validation|web-boot|unknown",
  "signature": "TypeError · this.holding is not a function",
  "fingerprint": "<12hex>",
  "message": "<=400 chars, secrets/credentials redacted",
  "stack": "<=3000 chars",
  "culprit": { "type": "plugin|package|core|unknown", "name": "dsh-inner-browser-use", "evidence": "sidecar.js:743" } | null,
  "artifact": "/abs/path.log",
  "ruleIds": [],
  "reportedToMemory": false
}
```

### Rule (lore)
```json
{
  "id": "R001",
  "title": "一条 <=40 字的硬约束（祈使句）",
  "signature": "正则字符串，匹配 signature+message+stack",
  "cause": "<=120 字根因",
  "fix": "<=120 字做法",
  "guard": { "kind": "source-regex|manifest|config", "pattern": "JS 正则", "message": "命中时给人看的一句话", "exclude": "(可选)正则" } | null,
  "severity": "fatal|boot|lint",
  "tags": ["host", "uncaught"],
  "hits": 0,
  "firstSeen": "ISO|null",
  "lastSeen": "ISO|null",
  "incidentIds": [],
  "memoryId": null
}
```

## core.mjs public API (ESM, no side effects at import)
- `storeDir(home?)`, `fetchArtifacts(dirs?) -> Artifact[]`, `parseArtifact(path) -> Incident|null`
- `fingerprint(kind, signature, frame)`; `redact(text)`
- `readIncidents() / appendIncident(inc) / readRules() / writeRules(rules) / upsertRule(rule)`
- `scan({force}) -> {added, bumped, known, unknown, ...}` — 同一 fingerprint 重复出现不丢弃，累加
  incident `count`/`lastTs`；`doctor --auto` 只用来源与时间明确、落在 24h 窗口内的真实事件判崩溃循环
  （同元凶 ≥3）。同一次事故有稳定 `occurrenceId`（fingerprint|artifact|ts 的短哈希），另存一份
  `occurrenceTimes`/`occurrenceSeen`（持久 Bloom 2048bit），因此显示窗口截断（最多 100 条）不会
  让重扫把旧事件当新增，旧格式只有 `count` 的聚合行最多算 1 次近期命中。
- `matchRules(incident, rules) -> Rule[]`
- `renderLorePrompt(rules, {maxChars=900}) -> string` (top rules, compact bullet list)
- guard.mjs has two layers, both pure static (never executes plugin code):
  - `preflight(dir) -> Finding[]` — loader-level contract checks P001–P033: manifest/exports/patch shape,
    duplicate patch ids, `node --check` on entry files, top-level throw/await, `require`/`__dirname` in ESM,
    `process.exit`/signal takeover, and the `tools.register` contract (`output.{schema,render}` is mandatory —
    missing it throws `TypeError: tool "<n>" must declare output` at activation). Severity `fatal`/`boot` blocks install.
  - `checkSource(dir, rules) -> Finding[]` — the lore's own regex guards (`source-regex|manifest|config`).
  - `renderAll(findings, dir) -> string` — merged report, fatal/boot first.

## Runtime defense layer (0.2.1, shipped entry `index.js`)
- 宿主约定：`ctx.tools.guard(guard)` 同步（返回字符串即拒绝，没有强制放行）；`tools/pre-execute`
  waterfall；拒绝原样回到**发起会话**，会话继续跑。`exec.arguments` 已冻结，插件不得改写。
- `defense.mjs`：`liveSurfaces`/`refreshSurfaces`（≤1 stat、>2s 节流、失败 fail-open 标 stale）、
  `classify`/`inspectText`/`proposedText`/`blockReason`、`guardWrite`、`guardShell`、`preExecute`、
  `DEFENSE_DEFAULTS`。规则 P001–P033 共用 guard.mjs，加运行期编号；只有证据足够的具体写法才硬拦
  （`BLOCKING` 白名单），其余只提示。目标解析统一走 `lib/resolve.mjs`：绝对/相对（按会话 cwd）/软链接
  realpath 归并成同一个 live 目标，结论必须一致。
- `state.mjs`：模式（protect / observe / off，中文档位别名并入）、三层状态（用户选择 / 实际能力 /
  本次结果）、拒绝记录（按调用唯一，热重载不丢不乱）、`denialFor` 供 PTC 原会话回传。状态从真实
  hook 存在性推导：接口缺失报 `不可用`，不冒充保护中。
- PTC（`run_code` 子调用）：子调用被拒时通过 `tools/post-execute` 的 `additionalContexts` 回到
  父 `run_code`，再进原会话 inbox，按 callId/rootCallId 去重，不广播、不终止会话。
- 覆盖边界（如实写、不假装全覆盖）：bash 里 `cat > file`、`run_code` 内自写 fs、外部编辑器保存、
  宿主自身升级，都绕过工具管线。
- 打包闭包：`files` 必须列全所有运行时模块（`index.js core.mjs guard.mjs defense.mjs cli.mjs
  memory.mjs doctor.mjs state.mjs lib/*.mjs` + 资源）；真实宿主用 `link:` 时看不出缺文件，只有
  tarball 冷装才暴露，所以 CI 必须 `npm pack` 后解包 `node --check` + 冷装启动。

## CLI (`cli.mjs`, node >= 20, no deps)
`scan` | `rules` | `check <pluginDir>`（preflight + 规则，命中 exit 1） | `doctor [--yes|--auto]` | `export`（只打印）/ `export --memory`（写记忆，默认不写） | `prompt [--chars N]`

`doctor` = outside-DSH self-heal: find latest fatal incident → resolve culprit plugin → back up and remove/disable it
from `$DSH_PROFILE_DIR/package.json` (dependencies + dsh.profile.bundles) and any matching rows in `cordis.patch.yml`
(comment out block, keep `.bak-<ts>`) → record QuarantineEntry → print one-line recovery instruction.
Never touch files it cannot parse back; always keep a `.bak-<ts>` copy.

## Ownership
- Lead: core.mjs, guard.mjs, cli.mjs, package.json, cordis.patch.yml, README, CONTRACT.md, 版本与发布
- agent-a-guard: defense.mjs, lib/**, test/defense.test.mjs, test/rules.test.mjs
- agent-b-host: index.js, state.mjs, locale/*.json, test/host.test.mjs
- agent-c-acceptance: test/integration/**, scripts/verify-*.mjs, fixtures/**（只交证据，不写产品代码）
- crash-forensics: corpus/**, rules.seed.json, docs/taxonomy.md
- memory-bridge: memory.mjs, doctor.mjs, test/memory.test.mjs, test/doctor.test.mjs
