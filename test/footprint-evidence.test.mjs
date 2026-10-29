/**
 * OOM evidence: the scan may only say how loaded the machine was if a footprint was written
 * *before* the death. These fixtures pin that rule in both directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, readIncidents } from '../core.mjs';
import { recordFootprint, footprintBefore, oomEvidenceLines, sessionFootprint } from '../lib/sessions.mjs';

const OOM_LOG = `time: 2026-10-29T02:34:25.078Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.3
platform: darwin arm64
node: 24.21.0

--- error ---
Error: dsh desktop host stopped: <--- Last few GCs --->

[91126:0x120008b0000]  3868858 ms: Scavenge 3653.9 (3714.4) -> 3639.3 (3719.6) MB, pooled: 0.0 MB, 3.63 / 0.00 ms

FATAL ERROR: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory
`;

const CRASH_AT = Date.parse('2026-10-29T02:34:25.078Z');
const SAMPLE_AT = Date.parse('2026-10-29T02:30:00.000Z');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeguard-fp-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function openSession(home, project, id, packedBytes, at) {
  const dir = path.join(home, 'sessions', project, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(packedBytes, 1));
  const lock = path.join(dir, 'session.lock');
  fs.writeFileSync(lock, 'pid');
  fs.utimesSync(lock, at / 1000, at / 1000);
}

test('footprintBefore returns only a sample taken before the incident', () => {
  const home = tmpHome();
  openSession(home, 'proj-alpha', 's-1', 20 * 1024 * 1024, SAMPLE_AT);
  const sample = recordFootprint(home, { now: SAMPLE_AT });
  assert.equal(sample.openCount, 1);
  assert.equal(sample.estimateGB, 0.1);

  const hit = footprintBefore(home, '2026-10-29T02:34:25.078Z');
  assert.equal(hit.openCount, 1);
  assert.equal(hit.ageMin, 4);

  // A sample written after the death is not evidence for it.
  assert.equal(footprintBefore(home, '2026-10-29T02:00:00.000Z'), null);
  // Nor is one from another day.
  assert.equal(footprintBefore(home, '2026-10-29T20:00:00.000Z', { maxAgeMs: 6 * 60 * 60 * 1000 }), null);
});

test('no history means no evidence, never a number invented at scan time', () => {
  const home = tmpHome();
  openSession(home, 'proj-alpha', 's-1', 20 * 1024 * 1024, Date.now());
  assert.equal(sessionFootprint(home).openCount >= 0, true);
  assert.equal(footprintBefore(home, '2026-10-29T02:34:25.078Z'), null);
});

test('scan attaches the pre-crash footprint to an OOM row', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'logs', 'crash-2026-10-29T02-34-25-078Z-host.log'), OOM_LOG);
  openSession(home, 'proj-alpha', 's-1', 100 * 1024 * 1024, SAMPLE_AT);
  recordFootprint(home, { now: SAMPLE_AT });

  const result = scan({ home });
  const oom = result.added.filter((incident) => incident.kind === 'out-of-memory');
  assert.ok(oom.length >= 1);
  const row = result.oomEvidence.find((entry) => entry.evidence);
  assert.ok(row, 'OOM row carries the pre-crash footprint');
  assert.equal(row.evidence.ageMin, 4);
  assert.equal(row.evidence.openCount, 1);
  assert.match(row.evidence.top[0].project, /proj\/alpha/);
  assert.ok(readIncidents(home).length >= 1);
  assert.ok(row.signature.startsWith('out-of-memory · heap'));
  assert.equal(CRASH_AT > SAMPLE_AT, true);
});

test('evidence line names the minutes, the count and the estimate', () => {
  const lines = oomEvidenceLines({ ageMin: 4, openCount: 3, estimateGB: 2.1, top: [{ project: '2026/Envoy', packedMB: 89 }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /崩前 4 分钟/);
  assert.match(lines[0], /3 个会话/);
  assert.match(lines[0], /2\.1 GB/);
  assert.match(lines[0], /2026\/Envoy 89 MB/);
  assert.deepEqual(oomEvidenceLines(null), []);
});
