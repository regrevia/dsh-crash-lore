/**
 * Attribution + loop rules, driven by hand-built incidents that mirror the real 2026-10-29 run:
 * a stack overflow inside a plugin's cleanup path, then heap deaths with no plugin stack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateIncidents, crashLoops, loopLines } from '../lib/attribute.mjs';

const overflow = {
  id: 'i-overflow',
  ts: '2026-10-28T18:08:20.000Z',
  kind: 'stack-overflow',
  signature: 'stack-overflow · Maximum call stack size exceeded',
  culprit: { type: 'plugin', name: 'dsh-mobile-use' },
  frame: 'scrcpy.js:1309',
};
const oom = {
  id: 'i-oom',
  ts: '2026-10-28T21:40:08.215Z',
  kind: 'out-of-memory',
  signature: 'out-of-memory · heap 3770 MB',
  culprit: { type: 'core', name: 'deepseek-harness' },
};

test('heap death is attributed to the plugin that crashed earlier in the same run', () => {
  const { incidents, correlated } = correlateIncidents([overflow, oom]);
  assert.equal(correlated, 1);
  assert.deepEqual(incidents[1].culprit, { type: 'plugin', name: 'dsh-mobile-use' });
  assert.equal(incidents[1].inferred, true);
  assert.equal(incidents[1].inference.from, 'i-overflow');
  assert.equal(incidents[1].inference.fromKind, 'stack-overflow');
  /* Parsed evidence stays visible: the dying process was still the host. */
  assert.equal(incidents[1].hostCulprit.name, 'deepseek-harness');
});

test('a crash hours away is not treated as the cause', () => {
  const late = { ...oom, ts: '2026-10-29T04:00:00.000Z' };
  const { incidents, correlated } = correlateIncidents([overflow, late], { windowMs: 30 * 60 * 1000 });
  assert.equal(correlated, 0);
  assert.equal(incidents[1].culprit.type, 'core');
  assert.equal(incidents[1].inferred, undefined);
});

test('correlation is idempotent and never chains off an inferred row', () => {
  const first = correlateIncidents([overflow, oom]).incidents;
  const second = correlateIncidents(first);
  assert.equal(second.correlated, 0);
  assert.deepEqual(second.incidents[1], first[1]);
  const third = correlateIncidents([overflow, oom, { ...oom, id: 'i-oom-2', ts: '2026-10-28T21:50:00.000Z' }]).incidents;
  assert.equal(third[2].inference.from, 'i-overflow');
});

test('crash loop needs three hits inside the window and names the plugin', () => {
  const times = ['2026-10-28T21:40:00.000Z', '2026-10-28T21:57:00.000Z', '2026-10-28T22:44:00.000Z'];
  const rows = correlateIncidents([
    overflow,
    ...times.map((ts, index) => ({ ...oom, id: `oom-${index}`, ts })),
  ]).incidents;
  const loops = crashLoops(rows, { now: '2026-10-28T23:30:00.000Z' });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].name, 'dsh-mobile-use');
  assert.equal(loops[0].count, 4);
  assert.equal(loops[0].inferredCount, 3);
  assert.match(loopLines(loops)[0], /dsh-mobile-use 24h 内 4 次/);
  assert.match(loopLines(loops)[0], /crash_lore_heal/);
});

test('two hits are not a loop, and rows outside the window are ignored', () => {
  const rows = [
    { ...overflow, ts: '2026-10-27T00:00:00.000Z' },
    { ...overflow, id: 'b', ts: '2026-10-28T20:00:00.000Z' },
    { ...overflow, id: 'c', ts: '2026-10-28T20:10:00.000Z' },
  ];
  assert.equal(crashLoops(rows, { now: '2026-10-28T21:00:00.000Z' }).length, 0);
});
