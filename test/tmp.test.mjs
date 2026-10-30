import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TTL_MS, MIN_AGE_MS, listTemp, maybeSweep, resetSweepClock, sweepTemp } from '../tmp.mjs';

const created = [];

/* 只给长度，不落真实字节：快照被量的是大小，测试不该吃掉磁盘。 */
function snapshot(root, name, packedMB, ageMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'sessions', '--proj--', 'session-a'), { recursive: true });
  const file = path.join(dir, 'sessions', '--proj--', 'session-a', 'session.v4.jsonl.zstd');
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, packedMB * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  if (ageMs !== undefined) {
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeguard-tmp-test-'));
  created.push(dir);
  return dir;
}

test.after(() => {
  resetSweepClock();
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

test('listTemp 只认自己的前缀', () => {
  const home = root();
  snapshot(home, 'lifeguard-sessions-aaa', 2);
  snapshot(home, 'crash-lore-sessions-bbb', 2);
  snapshot(home, 'someone-else-data', 2);
  const found = listTemp([home]);
  assert.deepEqual(found.map((row) => row.name).sort(), ['crash-lore-sessions-bbb', 'lifeguard-sessions-aaa']);
  assert.ok(found.every((row) => row.bytes === 2 * 1024 * 1024));
});

test('超过保留期的清掉，新鲜的留着', () => {
  const home = root();
  const old = snapshot(home, 'lifeguard-sessions-old', 2, DEFAULT_TTL_MS + 60_000);
  const fresh = snapshot(home, 'lifeguard-sessions-fresh', 2, 60_000);
  const result = sweepTemp({ roots: [home] });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('超预算时从最老的删到预算内', () => {
  const home = root();
  const oldest = snapshot(home, 'lifeguard-sessions-1', 100, 5 * 60 * 60 * 1000);
  const middle = snapshot(home, 'lifeguard-sessions-2', 100, 4 * 60 * 60 * 1000);
  const newest = snapshot(home, 'lifeguard-sessions-3', 100, 3 * 60 * 60 * 1000);
  const result = sweepTemp({ roots: [home], budgetMB: 150 });
  assert.equal(result.removed, 2);
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(newest), true);
  assert.ok(result.keptMB <= 150);
});

test('刚建的快照不因超预算被删', () => {
  const home = root();
  const fresh = snapshot(home, 'lifeguard-sessions-fresh', 300, 60_000);
  const result = sweepTemp({ roots: [home], budgetMB: 10 });
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(fresh), true);
});

test('保护名单和 dryRun 都不动文件', () => {
  const home = root();
  const old = snapshot(home, 'lifeguard-sessions-old', 2, DEFAULT_TTL_MS + 60_000);
  const plan = sweepTemp({ roots: [home], budgetMB: 1, dryRun: true });
  assert.equal(plan.removed, 1);
  assert.equal(fs.existsSync(old), true);
  const kept = snapshot(home, 'lifeguard-sessions-kept', 2, DEFAULT_TTL_MS + 60_000);
  const result = sweepTemp({ roots: [home], protect: [kept] });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(kept), true);
});

test('maybeSweep 半小时内只扫一次', () => {
  resetSweepClock();
  const home = root();
  snapshot(home, 'lifeguard-sessions-old', 2, DEFAULT_TTL_MS + 60_000);
  const now = Date.now();
  assert.equal(maybeSweep({ roots: [home], now })?.removed, 1);
  snapshot(home, 'lifeguard-sessions-old2', 2, DEFAULT_TTL_MS + 60_000);
  assert.equal(maybeSweep({ roots: [home], now: now + MIN_AGE_MS }), null);
  assert.equal(maybeSweep({ roots: [home], now: now + 31 * 60 * 1000 })?.removed, 1);
});
