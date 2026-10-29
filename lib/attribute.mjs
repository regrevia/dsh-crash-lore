/**
 * Attribution helpers: turn hard crash evidence into a culprit a human (or heal) can act on.
 *
 * Two jobs, both read-only on the incident list:
 *  - correlate: a host heap death has no plugin stack (V8 dies in GC, not in plugin code), so the
 *    log alone can never name the plugin. If a plugin crash of a different shape happened minutes
 *    earlier in the same run, that plugin is the credible cause; record it as *inferred*, never as
 *    parsed evidence.
 *  - loops: the same culprit dying again and again within a day is a crash loop, and the advice is
 *    "disable it first, repair second" rather than "read the log again".
 */

const HOST_ONLY_KINDS = new Set(['out-of-memory']);
const PLUGIN_KINDS = new Set(['stack-overflow', 'uncaught-exception', 'client-error', 'web-boot', 'startup-failed']);

/* A latent plugin bug can surface as a heap death hours into the same host run, so the default is
 * the run window, not the usual 30 minutes: a plugin crash earlier in the same session is the best
 * evidence available when the OOM log carries no plugin stack. */
const DEFAULT_CORRELATE_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOOP_WINDOW_MS = 24 * 60 * 60 * 1000;

function at(text) {
  const value = Date.parse(String(text ?? ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * Mark host-only crashes with the plugin that most likely caused them.
 * Pure: returns clones; rows that already carry a culprit are left alone.
 * @param {object[]} incidents
 * @param {{windowMs?: number}} options
 */
export function correlateIncidents(incidents, options = {}) {
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_CORRELATE_WINDOW_MS;
  const ordered = [...(incidents ?? [])].sort((a, b) => String(a?.ts ?? '').localeCompare(String(b?.ts ?? '')));
  const out = [];
  let correlated = 0;
  for (const incident of ordered) {
    if (!incident || typeof incident !== 'object') continue;
    const culprit = incident.culprit;
    const hostOnly = HOST_ONLY_KINDS.has(incident.kind) && (!culprit?.name || culprit.type === 'core');
    if (!hostOnly || incident.inferred) {
      out.push(incident);
      continue;
    }
    const when = at(incident.ts);
    let source = null;
    if (when !== null) {
      for (let index = out.length - 1; index >= 0; index -= 1) {
        const previous = out[index];
        const previousAt = at(previous?.ts);
        if (previousAt === null) continue;
        const gap = when - previousAt;
        if (gap < 0) continue;
        /* Sorted ascending, so every earlier row further back is even older. */
        if (gap > windowMs) break;
        if (!previous.inferred
          && previous.culprit?.type === 'plugin'
          && previous.culprit.name
          && PLUGIN_KINDS.has(previous.kind)) {
          source = { incident: previous, gap };
          break;
        }
      }
    }
    if (!source) {
      out.push(incident);
      continue;
    }
    correlated += 1;
    out.push({
      ...incident,
      culprit: { type: 'plugin', name: source.incident.culprit.name },
      inferred: true,
      inference: {
        from: source.incident.id ?? null,
        fromKind: source.incident.kind,
        fromSignature: source.incident.signature ?? '',
        gapMs: source.gap,
        reason: '堆耗尽日志里没有插件栈，按同一时段前一条插件崩溃归因',
      },
      /* Keep the parsed evidence visible: the host was in fact the dying process. */
      hostCulprit: culprit?.name ? { ...culprit } : { type: 'core', name: 'deepseek-harness' },
    });
  }
  return { incidents: out, correlated };
}

/**
 * Culprits that crashed at least `min` times inside the window.
 * @param {object[]} incidents
 * @param {{windowMs?: number, min?: number, now?: string|number}} options
 */
export function crashLoops(incidents, options = {}) {
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_LOOP_WINDOW_MS;
  const min = Number(options.min) > 0 ? Number(options.min) : 3;
  const now = options.now === undefined ? Date.now() : Number(at(options.now) ?? Date.now());
  const groups = new Map();
  for (const incident of incidents ?? []) {
    const name = incident?.culprit?.name;
    if (!name) continue;
    const when = at(incident.ts);
    if (when === null || now - when > windowMs) continue;
    const type = incident.culprit.type === 'core' ? 'core' : 'plugin';
    const key = `${type}:${name}`;
    const group = groups.get(key) ?? { type, name, count: 0, inferredCount: 0, first: incident.ts, last: incident.ts, kinds: new Set() };
    group.count += 1;
    if (incident.inferred) group.inferredCount += 1;
    if (String(incident.ts) < String(group.first)) group.first = incident.ts;
    if (String(incident.ts) > String(group.last)) group.last = incident.ts;
    group.kinds.add(incident.kind);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.count >= min)
    .map((group) => ({
      ...group,
      kinds: [...group.kinds],
      spanMs: Math.max(0, (at(group.last) ?? 0) - (at(group.first) ?? 0)),
    }))
    .sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)));
}

/** One status line per loop, phrased as the next action. */
export function loopLines(loops) {
  return (loops ?? []).map((loop) => {
    const inferred = loop.inferredCount ? `，其中 ${loop.inferredCount} 次按关联归因` : '';
    return `崩溃循环 ${loop.name} 24h 内 ${loop.count} 次（${loop.first}→${loop.last}${inferred}）→ 先 lifeguard_heal 停用再修`;
  });
}
