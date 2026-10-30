/**
 * Passive heap watchdog: the one pre-crash signal this plugin can produce.
 *
 * A host heap death gives no plugin stack and no chance to react, but memory climbs for minutes
 * before the ceiling. This samples the host heap on a slow timer and keeps a tiny ring, so the
 * status card can say "heap 2.9 GB, +180 MB/min" while the process is still alive. It never exits,
 * never throws, and never blocks a tool: the timer is unref'd, samples are best effort, and a failed
 * sample is dropped. Crossing the critical line records one alarm that survives the crash, so the
 * next run knows this plugin set has already been to the edge.
 */
import v8 from 'node:v8';
import { appendJsonl, paths, DEFAULT_HOME } from './core.mjs';
import { recordFootprint } from './lib/sessions.mjs';
import { wallFor } from './pressure.mjs';

const DEFAULTS = {
  intervalMs: 20_000,
  warnMB: 1800,
  criticalMB: 2800,
  releaseRatio: 0.6,
  keep: 180,
  persistEveryMs: 60_000,
  /* A directory walk over every session is ~100 ms on a large tree: sample it on a slow cadence
   * instead of every heap tick, so the watchdog stays a rounding error in the host. */
  footprintEveryMs: 5 * 60_000,
  keepPersisted: 1200,
};

function megabytes(value) {
  return Math.round((Number(value) || 0) / (1024 * 1024));
}

/**
 * Pure-ish sampler core: no timer, no IO unless `persist` is passed. Tests drive it directly.
 * @param {object} options
 */
export function createWatchdog(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const sample = typeof config.sample === 'function' ? config.sample : () => process.memoryUsage();
  const clock = typeof config.now === 'function' ? config.now : () => Date.now();
  const ring = [];
  const startedAt = clock();
  let lastTick = startedAt;
  let lastPersist = startedAt;
  let lastFootprint = startedAt;
  let peakMB = 0;
  let alarm = null;
  let picks = 0;

  function sampleOnce() {
    try {
      const usage = sample();
      const heapMB = megabytes(usage?.heapUsed);
      const rssMB = megabytes(usage?.rss);
      // The ceiling itself, so a raised heap limit is verifiable at runtime instead of assumed.
      const limitMB = megabytes(v8.getHeapStatistics().heap_size_limit);
      const stamp = clock();
      picks += 1;
      peakMB = Math.max(peakMB, heapMB);
      ring.push({ t: new Date(stamp).toISOString(), heapMB, rssMB, limitMB });
      if (ring.length > config.keep) ring.splice(0, ring.length - config.keep);
      if (heapMB >= config.criticalMB) {
        if (!alarm || alarm.released) alarm = { at: new Date(stamp).toISOString(), heapMB, released: false };
        else alarm.heapMB = Math.max(alarm.heapMB, heapMB);
      } else if (alarm && heapMB < config.warnMB * config.releaseRatio) {
        alarm = { ...alarm, released: true };
      }
      lastTick = stamp;
      if (typeof config.persist === 'function' && stamp - lastPersist >= config.persistEveryMs) {
        lastPersist = stamp;
        config.persist({ t: new Date(stamp).toISOString(), heapMB, rssMB, limitMB, peakMB });
        /* Written while the host is still alive, so a later OOM row can quote how loaded the
         * machine was; the scan never invents this number after the fact. */
        if (typeof config.footprint === 'function' && stamp - lastFootprint >= config.footprintEveryMs) {
          lastFootprint = stamp;
          config.footprint(stamp);
        }
      }
      return { heapMB, rssMB, limitMB };
    } catch {
      return null;
    }
  }

  function status() {
    const latest = ring[ring.length - 1] ?? null;
    const first = ring[0] ?? null;
    const spanMs = latest && first ? Date.parse(latest.t) - Date.parse(first.t) : 0;
    const trendMBPerMin = spanMs > 0 ? Math.round(((latest.heapMB - first.heapMB) / spanMs) * 60_000) : 0;
    return {
      running: Boolean(config.running),
      samples: picks,
      heapMB: latest?.heapMB ?? 0,
      rssMB: latest?.rssMB ?? 0,
      peakMB,
      limitMB: latest?.limitMB ?? 0,
      trendMBPerMin,
      since: new Date(startedAt).toISOString(),
      warnMB: config.warnMB,
      criticalMB: config.criticalMB,
      alarm: alarm ? { ...alarm } : null,
      lastTick: picks ? new Date(lastTick).toISOString() : null,
    };
  }

  return { sampleOnce, status, get alarm() { return alarm; }, config };
}

let active = null;

function persistSample(home, sample) {
  try {
    appendJsonl(paths(home).heap, sample);
  } catch {
    /* a watchdog that breaks the host would be worse than no watchdog */
  }
}

/**
 * Start the singleton sampler for this profile. Safe to call twice.
 * @param {string} home
 * @param {object} options
 */
export function startWatchdog(home = DEFAULT_HOME, options = {}) {
  if (active?.running) return active;
  const watcher = createWatchdog({
    ...options,
    running: true,
    persist: (sample) => persistSample(home, sample),
    footprint: (stamp) => recordFootprint(home, { now: stamp }),
  });
  active = watcher;
  /* First sample immediately: a restart after a crash should show the new baseline in the card. */
  watcher.sampleOnce();
  /* One baseline footprint right away: a crash inside the first sampling minute still has a
   * number to quote, and an idle machine costs one directory walk. */
  try {
    recordFootprint(home);
  } catch {
    /* best effort */
  }
  try {
    const timer = setInterval(() => watched(), Number(watcher.config.intervalMs));
    timer.unref?.();
    watcher.timer = timer;
  } catch {
    /* no timer service: keep the single baseline sample */
  }
  return watcher;
}

function watched() {
  active?.sampleOnce?.();
}

/** Latest host heap picture for the status card; all zeros when the timer never started. */
export function watchdogStatus() {
  return active ? active.status() : createWatchdog({ running: false }).status();
}

export function stopWatchdog() {
  if (active?.timer) clearInterval(active.timer);
  active = null;
}

/**
 * The sentence that has to reach the model while the host still has room: an alarm kept only in
 * the status card is read by nobody until someone asks, and the wall does not wait to be asked.
 * Empty below the warning line, so a healthy machine pays nothing.
 */
export function heapWarning(status = watchdogStatus(), options = {}) {
  if (!status?.samples) return '';
  const warnMB = options.warnMB ?? status.warnMB ?? 1800;
  const criticalMB = options.criticalMB ?? status.criticalMB ?? 2800;
  const alarmMB = status.alarm && !status.alarm.released ? status.alarm.heapMB : 0;
  const hot = Math.max(status.heapMB ?? 0, alarmMB);
  if (hot < warnMB) return '';
  const trend = status.trendMBPerMin > 0 ? `，最近每分钟 +${status.trendMBPerMin} MB` : '';
  return `【内存告警】本进程堆 ${status.heapMB} MB（峰值 ${status.peakMB} MB${trend}，${warnMB} MB 记警、约 ${criticalMB} MB 逼近上限）：先把还没完的会话收尾、重启宿主把内存拿回来，再继续；这时不要恢复大会话，也不要新开长会话。`;
}

/**
 * How close this process is to the wall that actually kills, in percent. `heap_size_limit` is only
 * an upper bound — V8 aborts when old space runs out first, which is earlier — so 100% has to mean
 * "dies here". Calibrate against the heap a real OOM was recorded at on this machine; with no
 * history, keep a 15% margin. The wall differs per machine, the calibration does not.
 */
export function heapPressure(status = watchdogStatus(), options = {}) {
  if (!status?.samples) return { pct: 0, wallMB: 0, basis: 'none' };
  /* The wall follows the runtime it is measured in: a crash point recorded under another heap
   * limit says nothing about this process, so it only counts while it still sits near that limit. */
  const { wallMB, basis } = wallFor({
    limitMB: Number(options.limitMB ?? status.limitMB ?? 0),
    crashMB: Number(options.crashMB ?? status.crashMB ?? 0),
    margin: options.margin,
  });
  const pct = wallMB > 0 ? Math.round(((status.heapMB ?? 0) / wallMB) * 100) : 0;
  return { pct, wallMB, basis };
}

/** One status line: heap now, growth per minute, and the last alarm if any. */
export function heapLine(status = watchdogStatus()) {
  if (!status?.samples) return '内存观测 未开始采样';
  const trend = status.trendMBPerMin > 0 ? `，+${status.trendMBPerMin} MB/min` : '';
  const alarm = status.alarm && !status.alarm.released ? `；上次运行到过 ${status.alarm.heapMB} MB（${status.alarm.at}）` : '';
  const pressure = heapPressure(status);
  const wall = pressure.wallMB > 0 ? `，${pressure.basis === 'crash' ? '崩溃点' : '按上限'} ${pressure.wallMB} MB` : '';
  return `内存观测 ${status.heapMB} MB（峰值 ${status.peakMB} MB${trend}，上限 ${status.limitMB} MB${wall}）${alarm}`;
}
