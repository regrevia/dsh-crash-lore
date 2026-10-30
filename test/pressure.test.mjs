import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, costOf, isExempt, levelOf, megabytes, readLive, wallFor } from '../pressure.mjs';

const reading = (over = {}) => ({ heapMB: 2000, limitMB: 4192, rssMB: 3000, at: 'now', ...over });

test('megabytes rounds bytes to a whole MB and refuses nonsense', () => {
  assert.equal(megabytes(1024 * 1024 * 7), 7);
  assert.equal(megabytes(0), 0);
  assert.equal(megabytes(-5), 0);
  assert.equal(megabytes('x'), 0);
});

test('a crash point near the running limit is the wall', () => {
  const wall = wallFor({ limitMB: 4192, crashMB: 4037 });
  assert.deepEqual(wall, { wallMB: 4037, limitMB: 4192, basis: 'crash' });
});

test('a crash point recorded under another runtime is not this wall', () => {
  const wall = wallFor({ limitMB: 6144, crashMB: 4037 });
  assert.equal(wall.basis, 'margin');
  assert.equal(wall.wallMB, Math.round(6144 * 0.85));
});

test('no crash history keeps the margin', () => {
  assert.deepEqual(wallFor({ limitMB: 4192 }), { wallMB: 3563, limitMB: 4192, basis: 'margin' });
  assert.equal(wallFor({ limitMB: 4192, crashMB: 0 }).basis, 'margin');
});

test('an unknown limit degrades instead of dividing by zero', () => {
  assert.deepEqual(wallFor({}), { wallMB: 0, limitMB: 0, basis: 'margin' });
});

test('levels come from the wall, not from the raw limit', () => {
  const wallMB = 4037;
  assert.equal(levelOf({ heapMB: 2000 }, { wallMB }).level, 'ok');
  assert.equal(levelOf({ heapMB: 2900 }, { wallMB }).level, 'watch');
  assert.equal(levelOf({ heapMB: 3500 }, { wallMB }).level, 'high');
  assert.equal(levelOf({ heapMB: 3900 }, { wallMB }).level, 'stop');
});

test('a cheap step is never blocked, even at the wall', () => {
  const verdict = admit(reading({ heapMB: 4000 }), { name: 'todo_write' });
  assert.equal(verdict.ok, true);
});

test('diagnostics stay usable so a full host can still be inspected and healed', () => {
  for (const name of ['lifeguard_guard', 'lifeguard_scan', 'lifeguard_heal', 'lifeguard_export', 'lifeguard_handoff']) {
    assert.equal(isExempt(name), name !== 'lifeguard_handoff', name);
  }
  assert.equal(admit(reading({ heapMB: 4000 }), { name: 'lifeguard_guard' }).ok, true);
});

test('an expensive step that would land on the wall is denied with the numbers', () => {
  const verdict = admit(reading({ heapMB: 3950 }), { name: 'bash' }, { crashMB: 4037 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'H001');
  assert.equal(verdict.numbers.heapMB, 3950);
  assert.equal(verdict.numbers.wallMB, 4037);
  assert.ok(verdict.numbers.projected > 4037);
  assert.match(verdict.reason, /上限 4192 MB/);
  assert.match(verdict.reason, /先不要跑它/);
});

test('the same step with room left runs', () => {
  assert.equal(admit(reading({ heapMB: 2000 }), { name: 'bash' }, { crashMB: 4037 }).ok, true);
});

test('a big read is refused once the heap is already at the wall, however small the step', () => {
  const verdict = admit(reading({ heapMB: 3900 }), { name: 'web_fetch' }, { crashMB: 4037 });
  assert.equal(verdict.ok, false);
});

test('session resume is priced as the most expensive core step', () => {
  assert.ok(costOf('resume_session') >= 500);
  assert.ok(costOf('read') < costOf('bash'));
  assert.equal(costOf(''), 25);
  assert.equal(costOf('some_unknown_tool'), 25);
});

test('readLive reports what V8 will enforce right now', () => {
  const live = readLive({
    sample: () => ({ heapUsed: 1024 * 1024 * 900, rss: 1024 * 1024 * 1400 }),
    readLimit: () => 1024 * 1024 * 4192,
  });
  assert.deepEqual({ heapMB: live.heapMB, rssMB: live.rssMB, limitMB: live.limitMB }, { heapMB: 900, rssMB: 1400, limitMB: 4192 });
});

test('a failing sampler yields zeros instead of throwing inside the hook', () => {
  const live = readLive({ sample: () => { throw new Error('boom'); }, readLimit: () => { throw new Error('boom'); } });
  assert.equal(live.heapMB, 0);
  assert.equal(live.limitMB, 0);
  assert.equal(admit(live, { name: 'bash' }).ok, true);
});
