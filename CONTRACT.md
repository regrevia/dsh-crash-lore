# dsh-crash-lore — internal contract (v1)

Purpose: harvest DSH crash artifacts → normalized incidents → compact guard rules ("lore") →
inject as agent constraints + export to dsh-lite-memory + preflight-check plugin code.

## Artifacts harvested (read-only)
- `~/Library/Logs/DeepSeek Harness/crash-*-host.log`      (macOS desktop host crash; source=`host-crash`)
- `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`  (source=`web-boot-crash`)
- `~/.dsh/logs/startup-<iso>-<uuid>.log`                  (source=`startup-diag`)
- Linux/other fallback: `$DSH_HOME/logs/`, `~/.config/dsh/logs/` — best effort.

## Store (owned by core.mjs)
Dir: `$DSH_HOME/crash-lore/` (default `~/.dsh/crash-lore/`)
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
  "app": "0.2.1-rc.3|null",
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
  incident `count`/`lastTs`；`doctor --auto` 用累计次数判定崩溃循环（24h 同元凶 ≥3）。
- `matchRules(incident, rules) -> Rule[]`
- `renderLorePrompt(rules, {maxChars=900}) -> string` (top rules, compact bullet list)
- guard.mjs has two layers, both pure static (never executes plugin code):
  - `preflight(dir) -> Finding[]` — loader-level contract checks P001–P033: manifest/exports/patch shape,
    duplicate patch ids, `node --check` on entry files, top-level throw/await, `require`/`__dirname` in ESM,
    `process.exit`/signal takeover, and the `tools.register` contract (`output.{schema,render}` is mandatory —
    missing it throws `TypeError: tool "<n>" must declare output` at activation). Severity `fatal`/`boot` blocks install.
  - `checkSource(dir, rules) -> Finding[]` — the lore's own regex guards (`source-regex|manifest|config`).
  - `renderAll(findings, dir) -> string` — merged report, fatal/boot first.

## CLI (`cli.mjs`, node >= 20, no deps)
`scan` | `rules` | `check <pluginDir>`（preflight + 规则，命中 exit 1） | `doctor [--yes|--auto]` | `export`（只打印）/ `export --memory`（写记忆，默认不写） | `prompt [--chars N]`

`doctor` = outside-DSH self-heal: find latest fatal incident → resolve culprit plugin → back up and remove/disable it
from `$DSH_PROFILE_DIR/package.json` (dependencies + dsh.profile.bundles) and any matching rows in `cordis.patch.yml`
(comment out block, keep `.bak-<ts>`) → record QuarantineEntry → print one-line recovery instruction.
Never touch files it cannot parse back; always keep a `.bak-<ts>` copy.

## Ownership
- Lead: core.mjs, guard.mjs, cli.mjs, index.js, package.json, cordis.patch.yml, locale, README
- crash-forensics: corpus/**, rules.seed.json, docs/taxonomy.md
- memory-bridge: memory.mjs, doctor.mjs, test/memory.test.mjs, test/doctor.test.mjs
