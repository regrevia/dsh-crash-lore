import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCK_FRESH_MS, PLAIN_RATIO, RESTORE_FACTOR, sessionFootprint, footprintLines } from '../lib/sessions.mjs';

function workspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-lore-sessions-'));
  const make = (project, id, packedMB, lockAgeMs) => {
    const dir = path.join(home, 'sessions', project, id);
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(transcript, Buffer.alloc(packedMB * 1024 * 1024, 1));
    /* Age the transcript with the lock: a resumed session appends to the same file, so freshness
     * is the newer of the two and a fixture that only ages one of them is not a stale session. */
    if (lockAgeMs !== null) {
      const when = (Date.now() - lockAgeMs) / 1000;
      fs.utimesSync(transcript, when, when);
      const lock = path.join(dir, 'session.lock');
      fs.writeFileSync(lock, '');
      fs.utimesSync(lock, when, when);
    }
    return dir;
  };
  return { home, make };
}

test('fresh locks count as open, stale locks do not', () => {
  const { home, make } = workspace();
  make('--proj-a--', 'session-a', 40, 60_000);
  make('--proj-b--', 'session-b', 10, 60_000);
  make('--proj-c--', 'session-c', 90, LOCK_FRESH_MS + 60_000);
  const footprint = sessionFootprint(home);
  assert.equal(footprint.openCount, 2);
  assert.equal(footprint.staleCount, 1);
  assert.equal(footprint.openPackedMB, 50);
  assert.deepEqual(
    footprint.open.map((row) => row.id),
    ['session-a', 'session-b'],
  );
  assert.equal(footprint.open[0].plainMB, Math.round(40 * PLAIN_RATIO));
  assert.equal(footprint.open[0].estimateMB, Math.round(40 * RESTORE_FACTOR));
});

test('a session without a lock file is not counted as open', () => {
  const { home, make } = workspace();
  make('--proj--', 'session-no-lock', 30, null);
  const footprint = sessionFootprint(home);
  assert.equal(footprint.openCount, 0);
  assert.equal(footprint.staleCount, 0);
});

test('estimate crosses the risk line only when enough heap is at stake', () => {
  const { home, make } = workspace();
  make('--proj--', 'session-small', 12, 60_000);
  const small = sessionFootprint(home);
  assert.equal(small.ceilingRisk, false);
  make('--proj--', 'session-big', 400, 60_000);
  /* The dir list is cached for half an hour; a refresh is the documented way to see new dirs. */
  const big = sessionFootprint(home, { indexTtlMs: 1 });
  assert.equal(big.ceilingRisk, true);
  assert.ok(big.estimateGB >= 2 && big.estimateGB < 9);
});

test('missing sessions root is empty, not an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-lore-nosessions-'));
  const footprint = sessionFootprint(home);
  assert.equal(footprint.openCount, 0);
  assert.equal(footprint.totalPackedMB, 0);
  assert.deepEqual(footprintLines(footprint), []);
});

test('lines name the biggest sessions and keep the stale count honest', () => {
  const { home, make } = workspace();
  make('--Users-apple-Desktop-2026-Envoy--', 'session-envoy', 89, 60_000);
  make('--Users-apple-Desktop-DSH--', 'session-dsh', 67, 60_000);
  make('--Users-apple-Desktop-work-Pet--', 'session-pet', 57, 60_000);
  make('--Users-apple-Desktop-old--', 'session-old', 120, LOCK_FRESH_MS + 3_600_000);
  const lines = footprintLines(sessionFootprint(home));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /宿主刚碰过 3 个会话/);
  assert.match(lines[0], /2026\/Envoy 89 MB/);
  assert.match(lines[1], /1 个会话留有旧锁/);
});
