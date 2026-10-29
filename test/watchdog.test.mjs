/**
 * Watchdog: a passive sampler. These tests drive it with fixed values, so they assert behaviour
 * (alarm, release, trend, silence on failure) rather than timing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog, heapLine, heapWarning } from '../watchdog.mjs';

function driven(values, stepMs = 20_000) {
  let index = 0;
  let clock = Date.parse('2026-10-29T00:00:00.000Z');
  const watcher = createWatchdog({
    sample: () => {
      const heapMB = values[Math.min(index, values.length - 1)];
      return { heapUsed: heapMB * 1024 * 1024, rss: (heapMB + 400) * 1024 * 1024 };
    },
    now: () => clock,
  });
  return {
    watcher,
    tick() {
      const result = watcher.sampleOnce();
      index += 1;
      clock += stepMs;
      return result;
    },
  };
}

test('samples accumulate and the trend is reported per minute', () => {
  const run = driven([1000, 1300, 1600]);
  run.tick(); run.tick(); run.tick();
  const status = run.watcher.status();
  assert.equal(status.samples, 3);
  assert.equal(status.heapMB, 1600);
  assert.equal(status.peakMB, 1600);
  /* Three samples span 40 s, so +600 MB is +900 MB/min. */
  assert.equal(status.trendMBPerMin, 900);
  assert.equal(status.alarm, null);
  assert.match(heapLine(status), /1600 MB/);
});

test('crossing the critical line records one alarm and keeps the peak', () => {
  const run = driven([2000, 2900, 3100]);
  run.tick(); run.tick(); run.tick();
  const status = run.watcher.status();
  assert.equal(status.alarm.heapMB, 3100);
  assert.equal(status.alarm.at, '2026-10-29T00:00:20.000Z');
  assert.match(heapLine(status), /上次运行到过 3100 MB/);
});

test('dropping well under the warning line releases the alarm', () => {
  const run = driven([2900, 1000]);
  run.tick(); run.tick();
  const status = run.watcher.status();
  assert.equal(status.alarm.released, true);
  assert.doesNotMatch(heapLine(status), /上次运行到过/);
});

test('a failing sampler never throws and never fakes a sample', () => {
  const watcher = createWatchdog({ sample: () => { throw new Error('gone'); } });
  assert.equal(watcher.sampleOnce(), null);
  assert.equal(watcher.status().samples, 0);
  assert.match(heapLine(watcher.status()), /未开始采样/);
});

test('scrollback stays bounded', () => {
  const run = driven([500]);
  for (let index = 0; index < 400; index += 1) run.tick();
  const status = run.watcher.status();
  assert.equal(status.samples, 400);
  assert.equal(run.watcher.config.keep, 180);
});

test('footprint is sampled on its own slow cadence, not on every heap tick', () => {
  let clock = Date.parse('2026-10-29T00:00:00.000Z');
  let footprintCalls = 0;
  const watcher = createWatchdog({
    sample: () => ({ heapUsed: 500 * 1024 * 1024, rss: 900 * 1024 * 1024 }),
    now: () => clock,
    persist: () => {},
    footprint: () => { footprintCalls += 1; },
    persistEveryMs: 20_000,
  });
  /* Six minutes of ticks: the first sample at the zero mark is inside the initial window, so the
   * walk happens on the following tick that crosses the 5-minute line, not every minute. */
  for (let at = 0; at <= 6 * 60_000; at += 20_000) { watcher.sampleOnce(); clock += 20_000; }
  assert.ok(footprintCalls >= 1 && footprintCalls <= 2, `footprint walks: ${footprintCalls}`);
  assert.ok(footprintCalls < 7, 'a minute-by-minute walk would be 7 calls');
});

test('below the warning line the prompt stays clean', () => {
  const run = driven([900, 1200]);
  run.tick(); run.tick();
  assert.equal(heapWarning(run.watcher.status()), '');
});

test('crossing the warning line puts one sentence into the prompt', () => {
  const run = driven([1900, 2100]);
  run.tick(); run.tick();
  const line = heapWarning(run.watcher.status());
  assert.match(line, /内存告警/);
  assert.match(line, /2100 MB/);
  assert.match(line, /重启宿主/);
});

test('an alarm keeps warning even after the heap drops back', () => {
  const run = driven([2900, 2600]);
  run.tick(); run.tick();
  assert.equal(run.watcher.status().alarm.released, false);
  assert.match(heapWarning(run.watcher.status()), /内存告警/);
});
