/**
 * core.mjs / guard.mjs unit tests. Fixtures are synthetic copies of the real artifact shapes,
 * so the suite never reads this machine's logs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArtifact,
  redact,
  fetchArtifacts,
  scan,
  importCorpus,
  readIncidents,
  readRules,
  upsertRule,
  renderLorePrompt,
  matchRules,
  seedRules,
  VERSION,
  migrateLegacyStore,
  storeDir,
} from '../core.mjs';
import { checkSource } from '../guard.mjs';

const HOST_LOG = `time: 2026-10-28T09:15:33.952Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: darwin arm64
node: 24.21.0

--- error ---
Error: dsh desktop host exited with 1: dsh: fatal uncaught exception: TypeError: this.holding is not a function
    at file:///opt/dev/dsh-inner-browser-use/sidecar.js?v=1:743:20
    at WebSocket.<anonymous> (file:///opt/dev/dsh-inner-browser-use/sidecar.js?v=1:800:5)

--- renderer console (error level, oldest first) ---
[error] Uncaught SyntaxError: Unexpected end of input
`;

const WEB_LOG = `time: 2026-10-28T09:15:39.953Z
source: web-boot
phase: boot
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3

--- error ---
Error: web boot: 1 entry did not activate
dsh-vantage: failed
    at file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/lib/main.js:12437:19

--- renderer console (error level, oldest first) ---
`;

const STARTUP_LOG = `WARNING: Raw diagnostics may contain configuration or credential values from plugin errors.

{
  timestamp: '2026-10-24T10:32:46.923Z',
  dshVersion: '0.2.1-rc.3',
  profile: 'desktop',
  error: StartupError: dsh: startup failed: 1 required plugin did not activate

  Failed plugins (1):
    agent-default-model
      Package: @deepseek-ai/dsh-agent-default-model
      ValidationError: invalid config:
        - $.provider missing required value (at provider)
          at resolveConfig (file:///Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-config/bin.js:252:11)
}
`;

const STACK_LOG = `time: 2026-10-28T18:08:20.844Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: darwin arm64
node: 24.21.0

--- error ---
Error: dsh desktop host stopped: Exception in PromiseRejectCallback:
file:///opt/dev/dsh-mobile-use/scrcpy.js?v=11:1309
    return new Promise((resolveCommand) => {
           ^

RangeError: Maximum call stack size exceeded

Exception in PromiseRejectCallback:
file:///opt/dev/dsh-mobile-use/scrcpy.js?v=12:1309
    return new Promise((resolveCommand) => {
           ^

RangeError: Maximum call stack size exceeded

    at ChildProcess.<anonymous> (file:///Applications/DeepSeek Harness.app/Contents/Resources/app.asar/lib/main.js:3845:36)
    at ChildProcess.wrapper (node:events:639:12)
`;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeguard-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function writeArtifact(home, name, body) {
  const file = path.join(home, 'logs', name);
  fs.writeFileSync(file, body);
  return file;
}

test('host crash: kind, signature, culprit, frame', () => {
  const home = tmpHome();
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-inner-browser-use': 'link:/opt/dev/dsh-inner-browser-use' } }));
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;
  try {
    const file = writeArtifact(home, 'crash-2026-10-28T09-15-33-952Z-host.log', HOST_LOG);
    const incident = parseArtifact(file);
    assert.equal(incident.kind, 'uncaught-exception');
    assert.equal(incident.signature, 'TypeError · this.holding is not a function');
    assert.equal(incident.culprit.name, 'dsh-inner-browser-use');
    assert.equal(incident.culprit.type, 'plugin');
    assert.equal(incident.frame, 'sidecar.js:743');
    assert.match(incident.id, /^inc_[0-9a-f]{12}$/);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previous;
  }
});

test('stack overflow: names the recursing module, not the host stop frame', () => {
  const home = tmpHome();
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile-use': 'link:/opt/dev/dsh-mobile-use' } }));
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;
  try {
    const incident = parseArtifact(writeArtifact(home, 'crash-2026-10-28T18-08-20-844Z-host.log', STACK_LOG));
    assert.equal(incident.kind, 'stack-overflow');
    assert.equal(incident.signature, 'stack-overflow · scrcpy.js:1309');
    assert.equal(incident.frame, 'scrcpy.js:1309');
    assert.equal(incident.culprit.type, 'plugin');
    assert.equal(incident.culprit.name, 'dsh-mobile-use');
    /* ?v= is a cache buster, not part of the shape: the same bug must not fork per reload. */
    const reloaded = parseArtifact(writeArtifact(home, 'crash-b-host.log', STACK_LOG.replace('?v=11', '?v=12')));
    assert.equal(reloaded.fingerprint, incident.fingerprint);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previous;
  }
});

test('web boot failure: entry named as culprit', () => {
  const home = tmpHome();
  const incident = parseArtifact(writeArtifact(home, 'crash-2026-10-28T09-15-39-953Z-web-boot.log', WEB_LOG));
  assert.equal(incident.source, 'web-boot-crash');
  assert.equal(incident.kind, 'web-boot');
  assert.equal(incident.signature, 'web boot · 1 entry did not activate: dsh-vantage: failed');
  assert.equal(incident.culprit.name, 'dsh-vantage');
});

test('startup diagnostic: config validation, package culprit, timestamp', () => {
  const home = tmpHome();
  const incident = parseArtifact(writeArtifact(home, 'startup-2026-10-24T10-32-46.923Z-abc.log', STARTUP_LOG));
  assert.equal(incident.source, 'startup-diag');
  assert.equal(incident.kind, 'config-validation');
  assert.equal(incident.signature, 'ValidationError · $.provider missing required value (at provider)');
  assert.equal(incident.culprit.name, '@deepseek-ai/dsh-agent-default-model');
  assert.equal(incident.ts, '2026-10-24T10:32:46.923Z');
});

test('redaction removes credential shapes but keeps the crash text', () => {
  const text = redact('apiKey: sk-live-abcdefghijkl token=deadbeef123456 Authorization: Bearer abc.def.ghi TypeError: boom');
  assert.ok(!text.includes('sk-live-abcdefghijkl'));
  assert.ok(!text.includes('deadbeef123456'));
  assert.ok(!text.includes('abc.def.ghi'));
  assert.ok(text.includes('TypeError: boom'));
});

test('scan dedupes by fingerprint and is incremental', () => {
  const home = tmpHome();
  writeArtifact(home, 'crash-a-host.log', HOST_LOG);
  writeArtifact(home, 'crash-b-host.log', HOST_LOG);
  const dirs = [path.join(home, 'logs')];
  const first = scan({ home, dirs });
  assert.equal(first.harvested, 2);
  assert.equal(first.added.length, 2, 'one host incident + one renderer incident, deduped across both files');
  assert.deepEqual(first.added.map((item) => item.kind).sort(), ['plugin-activation', 'uncaught-exception']);
  const second = scan({ home, dirs });
  assert.equal(second.harvested, 0, 'unchanged artifacts are not re-read');
  assert.equal(readIncidents(home).length, 2);
});

test('rules: upsert by title, match by signature regex, render budget', () => {
  const home = tmpHome();
  const rule = upsertRule({ title: '事件回调不要抛未捕获异常', signature: 'this\\.holding is not a function', severity: 'fatal', fix: '回调里 try/catch 或换异步边界' }, home);
  assert.match(rule.id, /^R\d{3}$/);
  const again = upsertRule({ title: '事件回调不要抛未捕获异常', cause: '新版接口改了', severity: 'fatal' }, home);
  assert.equal(again.id, rule.id);
  assert.equal(again.cause, '新版接口改了');
  assert.equal(readRules(home).length, 1);
  const incident = parseArtifact(writeArtifact(home, 'crash-c-host.log', HOST_LOG));
  assert.deepEqual(matchRules(incident, readRules(home)).map((item) => item.id), [rule.id]);
  /* 0 = 不进提示词：规则清单只在面板里看（默认值），别再把每一轮请求撑长。 */
  assert.equal(renderLorePrompt(readRules(home), { maxChars: 0 }), '');
  const prompt = renderLorePrompt(readRules(home), { maxChars: 200 });
  assert.ok(prompt.includes('事件回调不要抛未捕获异常'));
  assert.ok(prompt.length <= 200 + 40);
});

test('fetchArtifacts only reports crash/startup logs', () => {
  const home = tmpHome();
  writeArtifact(home, 'crash-x.log', HOST_LOG);
  writeArtifact(home, 'startup-y.log', STARTUP_LOG);
  writeArtifact(home, 'notes.log', 'noise');
  const names = fetchArtifacts(home, [path.join(home, 'logs')]).map((artifact) => path.basename(artifact.path));
  assert.deepEqual(names.sort(), ['crash-x.log', 'startup-y.log']);
});

test('guard: source regex hits with line number, exclude respected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeguard-src-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply(ctx) {\n  process.exit(1)\n}\n');
  fs.writeFileSync(path.join(dir, 'safe.js'), '// process.exit(1) is discussed here\n');
  const rules = [{
    id: 'R001',
    title: '插件里不要调 process.exit',
    severity: 'fatal',
    fix: '用 throw 交给宿主或 ctx.effect 清理',
    guard: { kind: 'source-regex', pattern: 'process\\.exit\\(', message: '退出码由宿主决定', exclude: 'safe\\.js' },
  }];
  const findings = checkSource(dir, rules);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'index.js');
  assert.equal(findings[0].line, 2);
});

test('scan counts repeated crashes instead of dropping them', () => {
  const home = tmpHome();
  const dirs = [path.join(home, 'logs')];
  writeArtifact(home, 'crash-a-host.log', HOST_LOG);
  const first = scan({ home, dirs });
  assert.equal(first.added.length, 2);
  const before = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(before.count, 1);
  writeArtifact(home, 'crash-b-host.log', HOST_LOG);
  const second = scan({ home, dirs });
  assert.equal(second.bumped, 2);
  const after = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(after.count, 2, 'the same fingerprint seen again increments its count');
  assert.equal(readIncidents(home).length, 2);
});

test('frame: named frames `at Fn (file:///…:line:col)` parse to the source location', () => {
  const home = tmpHome();
  const log = `time: 2026-10-28T11:00:00.000Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1
platform: darwin arm64
node: 24.21.0

--- error ---
Error: boom
    at DemoClass.close (file:///opt/demo-plugin/index.js:10:2)
    at async run (/opt/demo-plugin/index.js:20:5)
`;
  const incident = parseArtifact(writeArtifact(home, 'crash-named-host.log', log));
  assert.ok(incident, 'artifact should parse');
  assert.equal(incident.frame, 'index.js:10', 'named frames must resolve, not come back null');
  assert.equal(incident.frameFile, '/opt/demo-plugin/index.js');
});

test('scan: force rescan is idempotent, and a new event on a new day advances lastTs', () => {
  const home = tmpHome();
  const dirs = [path.join(home, 'logs')];
  const base = HOST_LOG.replace('2026-10-28T09:15:33.952Z', '2026-10-20T09:15:33.952Z');
  writeArtifact(home, 'crash-old-host.log', base);
  scan({ home, dirs });
  const before = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(before.count, 1);
  assert.equal(before.lastTs, before.ts);

  writeArtifact(home, 'crash-new-host.log', HOST_LOG);
  scan({ home, dirs });
  const bumped = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(bumped.count, 2, 'a genuinely new event counts');
  assert.equal(bumped.lastTs, '2026-10-28T09:15:33.952Z', 'lastTs advances with the newest event');

  const forced = scan({ home, dirs, force: true });
  assert.equal(forced.bumped, 0, 're-parsing the same artifacts must not count them again');
  const after = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(after.count, 2);
  assert.equal(after.occurrenceTimes.length, 2);
});

test('VERSION 与 package.json 一致（发版时不会忘了改常量）', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, manifest.version);
});

test('scan migrates legacy aggregate rows：count 保留，补出每次发生的时间', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'lifeguard'), { recursive: true });
  fs.writeFileSync(path.join(home, 'lifeguard', 'incidents.jsonl'), `${JSON.stringify({
    id: 'inc_legacy',
    ts: '2025-10-01T00:00:00.000Z',
    lastTs: '2025-10-05T00:00:00.000Z',
    count: 5,
    fingerprint: 'legacy',
    kind: 'crash',
    signature: 'boom',
    culprit: { type: 'plugin', name: 'dsh-bad' },
    artifact: '/tmp/inc_legacy',
  })}\n`);
  scan({ home, dirs: [], force: true });
  const [migrated] = readIncidents(home);
  assert.equal(migrated.count, 5, '老条目的累计次数不能丢');
  assert.equal(migrated.occurrenceTimes.length, 5);
  assert.equal(migrated.lastTs, '2025-10-05T00:00:00.000Z');
});

test('事件数超过身份保留上限后，count 仍然准确（上限只截身份，不截事实）', () => {
  const home = tmpHome();
  const dirs = [path.join(home, 'logs')];
  const total = 105;
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const stamps = [];
  for (let at = 0; at < total; at += 1) {
    const stamp = new Date(base + at * 3600 * 1000).toISOString();
    stamps.push(stamp);
    writeArtifact(home, `crash-${at}-host.log`, HOST_LOG.replace('2026-10-28T09:15:33.952Z', stamp));
  }
  scan({ home, dirs });
  const row = readIncidents(home)[0];
  assert.equal(row.count, total, '累计次数必须是真实事件数，不能停在身份上限');
  assert.equal(row.occurrenceIds.length, 100, '身份列表截到上限，避免无限增长');
  assert.equal(row.occurrenceTimes.length, 100);
  assert.ok(row.occurrenceSeen && row.occurrenceSeen2, '身份记忆用两个独立过滤器，单次位碰撞不能吞掉真实事件');
  assert.equal(row.lastTs, stamps[stamps.length - 1]);
  const forced = scan({ home, dirs, force: true });
  assert.equal(forced.bumped, 0, '重扫不得再累加');
  assert.equal(readIncidents(home)[0].count, total);
});

test('importCorpus dedupes by fingerprint across repeated runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeguard-import-'));
  const corpus = path.join(home, 'corpus.jsonl');
  fs.writeFileSync(corpus, [
    JSON.stringify({ fingerprint: 'fp-one', ts: '2026-01-01T00:00:00.000Z', count: 1, signature: 'x' }),
    JSON.stringify({ fingerprint: 'fp-two', ts: '2026-01-02T00:00:00.000Z', count: 1, signature: 'y' }),
  ].join('\n') + '\n');
  assert.equal(importCorpus(home, corpus).imported, 2);
  assert.equal(importCorpus(home, corpus).imported, 0);
  assert.equal(readIncidents(home).length, 2);
});

test('旧条目补出真实事件后，强制重扫不再把累计次数叠成新事件', () => {
  const home = tmpHome();
  const dirs = [path.join(home, 'logs')];
  writeArtifact(home, 'crash-one-host.log', HOST_LOG);
  scan({ home, dirs });
  const row = readIncidents(home)[0];
  assert.equal(row.count, 1);
  /* Roll the stored row back to the pre-0.2.1 aggregate shape: count kept, per-event ids gone. */
  const { occurrenceIds, occurrenceTimes, occurrenceSynthetic, ...legacy } = row;
  fs.writeFileSync(path.join(home, 'lifeguard', 'incidents.jsonl'), `${JSON.stringify(legacy)}\n`);
  const first = scan({ home, dirs, force: true });
  const afterFirst = readIncidents(home)[0];
  assert.equal(afterFirst.count, 1, '一份真实日志只能算一次，不能把迁移补出的次数当新事件再加一');
  assert.equal(afterFirst.occurrenceIds.length, 1);
  assert.equal(afterFirst.occurrenceSynthetic, false);
  /* Everything from here on must converge: no bumps, no growth. */
  for (let round = 0; round < 3; round += 1) {
    const result = scan({ home, dirs, force: true });
    assert.equal(result.bumped, 0, `第 ${round + 2} 次强制重扫不得再记新事件`);
    assert.equal(readIncidents(home)[0].count, 1);
  }
});

test('首次出现三份事故落成三条事件，不是一条', () => {
  const home = tmpHome();
  const dirs = [path.join(home, 'logs')];
  const times = ['2026-10-28T09:15:33.952Z', '2026-10-28T10:15:33.952Z', '2026-10-28T11:15:33.952Z'];
  times.forEach((time, at) => writeArtifact(home, `crash-${at}-host.log`, HOST_LOG.replace('2026-10-28T09:15:33.952Z', time)));
  scan({ home, dirs });
  const row = readIncidents(home).find((item) => item.kind === 'uncaught-exception');
  assert.equal(row.count, 3, '三份独立事故必须落成三条');
  assert.equal(row.occurrenceIds.length, 3);
  assert.equal(row.lastTs, times[2], 'lastTs 取最新一次');
  const forced = scan({ home, dirs, force: true });
  assert.equal(forced.bumped, 0, '101 条同形日志重扫不增数');
  assert.equal(readIncidents(home).find((item) => item.kind === 'uncaught-exception').count, 3);
});

const OOM_LOG = `time: 2026-10-28T21:40:08.215Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: darwin arm64
electron: 44.7.0
node: 24.21.0

--- error ---
Error: dsh desktop host stopped: <--- Last few GCs --->

[75480:0x108008b0000]   753895 ms: Scavenge 3701.7 (3758.6) -> 3687.2 (3764.9) MB, pooled: 0.0 MB, 3.76 / 0.00 ms (average mu = 0.944, current mu = 0.957) allocation failure; 
[75480:0x108008b0000]   753921 ms: Scavenge 3712.7 (3770.1) -> 3698.2 (3775.7) MB, pooled: 0.0 MB, 3.59 / 0.00 ms (average mu = 0.944, current mu = 0.957) allocation failure; 

    at ChildProcess.<anonymous> (file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/lib/main.js:3845:36)
    at ChildProcess.emit (node:events:514:28)
`;

test('heap death: reads the GC diary instead of filing it as unknown', () => {
  const home = tmpHome();
  const incident = parseArtifact(writeArtifact(home, 'crash-oom-host.log', OOM_LOG));
  assert.equal(incident.kind, 'out-of-memory');
  /* 提交堆 3770.1 MB：括号里的第二个数是被占满的额度，不是前一个采样点 */
  assert.equal(incident.signature, 'out-of-memory · heap 3770 MB');
  assert.equal(incident.frame, 'main.js:3845');
});

test('升级改名：旧数据目录并进新目录，只搬不删，读写都不断', () => {
  const home = tmpHome();
  const legacy = path.join(home, 'crash-lore');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'state.json'), JSON.stringify({ quarantine: [{ name: 'dsh-old' }], scanned: {} }));
  fs.writeFileSync(path.join(legacy, 'incidents.jsonl'), `${JSON.stringify({ id: 'inc_old', ts: '2025-10-01T00:00:00.000Z', kind: 'crash', signature: 'old crash' })}\n`);
  fs.writeFileSync(path.join(home, 'lineage.jsonl'), `${JSON.stringify({ parent: 'a', child: 'b' })}\n`);
  fs.mkdirSync(path.join(home, 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(home, 'handoff', 'b.md'), '交接单');

  /* 迁移前：读旧位置也要能读到，不然升级当场就断片。 */
  assert.equal(readIncidents(home).length, 1);
  migrateLegacyStore(home);

  const dir = storeDir(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).quarantine, [{ name: 'dsh-old' }]);
  assert.equal(readIncidents(home).length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'lineage.jsonl')), '血缘记录要跟着搬进新目录');
  assert.ok(fs.existsSync(path.join(dir, 'handoff', 'b.md')), '交接单文件也要搬');
  assert.ok(fs.existsSync(legacy), '旧目录只搬不删，迁移失败还能回退');
  assert.ok(fs.existsSync(path.join(home, 'lineage.jsonl')), '旧位置的散文件只复制不删，回退旧版本还能读');

  /* 再跑一次什么都不变：迁移必须幂等。 */
  migrateLegacyStore(home);
  assert.equal(readIncidents(home).length, 1);
});

test('CRLF 不改变结论：Windows 检出/日志整份按 \\n 解析', () => {
  const home = tmpHome();
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-inner-browser-use': 'link:/opt/dev/dsh-inner-browser-use' } }));
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;
  try {
    const crlf = HOST_LOG.split('\n').join('\r\n');
    const file = writeArtifact(home, 'crash-2026-10-28T09-15-33-952Z-host.log', crlf);
    const incident = parseArtifact(file);
    assert.equal(incident?.signature, 'TypeError · this.holding is not a function');
    assert.equal(incident?.culprit?.name, 'dsh-inner-browser-use');
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previous;
  }
});

test('随包规则不按 URL.pathname 找：Windows 上也能从默认路径导入', () => {
  const home = tmpHome();
  const result = seedRules(home);
  assert.ok(result.seeded > 0, `期望从 ${result.file} 导入规则，实际 ${result.seeded} 条`);
  assert.ok(readRules(home).length > 0);
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(path.resolve(result.file), path.resolve(here, '..', 'rules.seed.json'));
});
