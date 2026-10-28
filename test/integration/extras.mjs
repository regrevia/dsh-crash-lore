#!/usr/bin/env node
/**
 * Acceptance evidence that complements the 8-item matrix:
 *   - e1/e2: event count stays truthful past the per-event identity cap (100), and a forced
 *            rescan does not invent new events (external check, real artifacts on disk).
 *   - e3/e4/e5: quarantine records belong to one profile; isolating `dsh-bad` in `work`
 *            must not stop `desktop` from planning its own quarantine, while legacy
 *            records without a profile still apply everywhere.
 *
 * Run: node test/integration/extras.mjs   -> /tmp/cl-acceptance-extras.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { scan, paths, readIncidents, readState, writeState } from '../../core.mjs';
import { planDoctor } from '../../doctor.mjs';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: String(detail ?? 'ok') });
    console.log(`PASS  ${name} · ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL  ${name} · ${error.message}`);
  }
}

const HOST_LOG = `time: 2026-10-28T09:15:33.952Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: darwin arm64
node: 24.21.0

--- error ---
Error: dsh desktop host exited with 1: dsh: fatal uncaught exception: TypeError: this.holding is not a function
    at file:///opt/dev/dsh-inner-browser-use/sidecar.js?v=1:743:20
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-extras-'));

/* ------------------------------------------------- event count past the cap */
{
  const home = path.join(root, 'cap-home');
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const stamps = [];
  for (let at = 0; at < 105; at += 1) {
    const stamp = new Date(base + at * 3600 * 1000).toISOString();
    stamps.push(stamp);
    fs.writeFileSync(path.join(logs, `crash-${at}-host.log`), HOST_LOG.replace('2026-10-28T09:15:33.952Z', stamp));
  }
  scan({ home, dirs: [logs] });
  const first = readIncidents(home)[0];
  const firstCount = first.count;
  check('e1-cap-truthful-count', () => {
    assert.equal(firstCount, 105, `count=${firstCount}`);
    assert.equal(first.occurrenceIds.length, 100);
    assert.equal(first.occurrenceTimes.length, 100);
    assert.equal(first.lastTs, stamps[stamps.length - 1]);
    return `count=105 · ids=${first.occurrenceIds.length} · lastTs=${first.lastTs}`;
  });
  scan({ home, dirs: [logs], force: true });
  check('e2-force-rescan-no-growth', () => {
    const after = readIncidents(home)[0];
    assert.equal(after.count, 105, `count grew to ${after.count}`);
    assert.equal(after.occurrenceIds.length, 100);
    return `count still ${after.count} after force rescan`;
  });
}

/* --------------------------------------------- quarantine scoped by profile */
{
  const home = path.join(root, 'scope-home');
  fs.mkdirSync(paths(home).dir, { recursive: true });
  const profiles = {};
  for (const name of ['work', 'desktop']) {
    const dir = path.join(root, 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: `cl-${name}`, private: true, dependencies: { 'dsh-bad': '0.0.1', 'dsh-old': '0.0.1' } }, null, 2)}\n`,
    );
    profiles[name] = dir;
  }
  const incident = (name) => ({
    id: `inc-${name}`,
    fingerprint: `fp-${name}`,
    ts: '2026-10-28T09:15:33.952Z',
    kind: 'fatal',
    signature: `${name}: top-level throw`,
    message: `${name} crashed at boot`,
    stack: 'Error: boom\n    at file:///tmp/x/index.js:1:1',
    culprit: { type: 'plugin', name, evidence: 'index.js:1' },
  });
  const incidents = [incident('dsh-bad'), incident('dsh-old')];
  fs.writeFileSync(paths(home).incidents, `${incidents.map((i) => JSON.stringify(i)).join('\n')}\n`);
  // `dsh-bad` was quarantined in the work profile only; `dsh-old` predates profiles.
  writeState(
    { ...readState(home), quarantine: [{ name: 'dsh-bad', profile: 'work', at: '2026-10-28T10:00:00.000Z' }, { name: 'dsh-old', at: '2026-10-28T10:00:00.000Z' }] },
    home,
  );
  check('e3-work-record-suppresses-work', () => {
    const plan = planDoctor({ home, profileDir: profiles.work, dryRun: true });
    assert.equal(plan.action, 'none', `action=${plan.action}`);
    return `work -> ${plan.action} (${plan.reason})`;
  });
  check('e4-desktop-not-suppressed-by-work', () => {
    const plan = planDoctor({ home, profileDir: profiles.desktop, dryRun: true });
    assert.equal(plan.action, 'quarantine', `action=${plan.action}`);
    assert.equal(plan.quarantineEntry.profile, 'desktop');
    assert.equal(plan.quarantineEntry.name, 'dsh-bad');
    return `desktop -> quarantine dsh-bad (entry.profile=desktop)`;
  });
  check('e5-legacy-record-applies-everywhere', () => {
    const legacyHome = path.join(root, 'legacy-home');
    fs.mkdirSync(paths(legacyHome).dir, { recursive: true });
    fs.writeFileSync(paths(legacyHome).incidents, `${JSON.stringify(incident('dsh-old'))}\n`);
    writeState({ quarantine: [{ name: 'dsh-old', at: '2026-10-28T10:00:00.000Z' }] }, legacyHome);
    for (const name of ['work', 'desktop']) {
      const dir = path.join(root, 'legacy', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: `cl-legacy-${name}`, dependencies: { 'dsh-old': '0.0.1' } }, null, 2)}\n`);
      const plan = planDoctor({ home: legacyHome, profileDir: dir, dryRun: true });
      assert.equal(plan.action, 'none', `${name}: action=${plan.action}`);
    }
    return 'legacy dsh-old suppressed in both profiles';
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsummary: ${results.length - failed.length} pass, ${failed.length} fail (artefacts ${root})`);
fs.writeFileSync('/tmp/cl-acceptance-extras.json', `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
console.log('results: /tmp/cl-acceptance-extras.json');
process.exitCode = failed.length ? 1 : 0;
