/**
 * Defense state: three layers that must never be conflated.
 *
 * - mode: what the user chose — 开启 / 仅监测 / 关闭.
 * - capability: what the host actually wired — 正常 / 部分覆盖 / 不可用 / 检查异常 / 已关闭.
 * - result: what the most recent check did — 放行 / 观察到风险 / 已阻止 / 未检查.
 *
 * The module keeps one live object per process. `ctx.effect` owns hook disposal, so a
 * hot reload disposes the old hooks before the next `apply` registers new ones; the live
 * object survives that reload, which keeps the denial history and the "already told the
 * origin session" ledger intact instead of resetting them on every apply.
 */

export const MODES = Object.freeze(['protect', 'observe', 'off']);
export const LAYERS = Object.freeze(['write', 'preExecute']);

export const MODE_LABELS = Object.freeze({ protect: '开启', observe: '仅监测', off: '关闭' });
export const CAPABILITY_LABELS = Object.freeze({
  normal: '正常',
  partial: '部分覆盖',
  unavailable: '不可用',
  error: '检查异常',
  off: '已关闭',
});
export const RESULT_LABELS = Object.freeze({ allow: '放行', observe: '观察到风险', deny: '已阻止', none: '未检查' });

const MAX_DENIALS = 50;
const MAX_LEDGER = 200;

/* Chinese labels are what the settings menu shows, so a value copied from the UI must come back
 * as the same mode instead of silently resetting to the default. */
const MODE_ALIASES = Object.freeze({ 开启: 'protect', 仅监测: 'observe', 关闭: 'off' });

/** Coerce a stored value into one of the three modes; unknown values fall back. */
export function normalizeMode(value, fallback = 'protect') {
  const direct = MODE_ALIASES[value] || value;
  if (MODES.includes(direct)) return direct;
  const base = MODE_ALIASES[fallback] || fallback;
  return MODES.includes(base) ? base : 'protect';
}

/** A live-editable config field arrives as a ref; plain values arrive as themselves. */
function readField(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * The mode a config explicitly asks for, or null when it says nothing.
 * `mode` wins; the legacy pair still works for profiles written before it existed:
 * `guard: false` means off, `monitorOnly: true` means observe.
 */
export function explicitMode(config) {
  if (config && typeof config === 'object') {
    const mode = readField(config.mode);
    if (MODES.includes(mode)) return mode;
    if (MODES.includes(MODE_ALIASES[mode])) return MODE_ALIASES[mode];
    if (config.guard === false) return 'off';
    if (config.monitorOnly === true) return 'observe';
  }
  return null;
}

/** Resolve the effective mode from a plugin config, defaulting to 开启. */
export function modeOfConfig(config) {
  return explicitMode(config) ?? 'protect';
}

function emptyHooks() {
  return { write: null, preExecute: null };
}

/** A fresh live object; the process-wide one is created by `defenseRuntime`. */
export function createDefenseState() {
  return {
    mode: 'protect',
    /* Set right after a mode was written through the config editor, before the restarted
     * plugin re-applies: hooks still installed must stop denying at once. */
    override: null,
    hooks: emptyHooks(),
    denials: [],
    denialKeys: new Set(),
    ledger: new Set(),
    lastResult: null,
    lastError: null,
  };
}

let live = null;

/** The object `index.js` mutates and reads. */
export function defenseRuntime() {
  if (!live) live = createDefenseState();
  return live;
}

/** Read-only view of the process-wide state, for the guard tool and any future page. */
export function defenseState() {
  return snapshot(defenseRuntime());
}

/** Tests only: drop the process-wide object. */
export function resetDefenseState() {
  live = null;
}

export function setMode(state, mode) {
  state.mode = normalizeMode(mode, state.mode);
  return state.mode;
}

export function setHook(state, layer, value) {
  if (!LAYERS.includes(layer)) throw new Error(`unknown hook layer: ${layer}`);
  state.hooks[layer] = value ?? null;
}

export function clearHooks(state) {
  state.hooks = emptyHooks();
}

/**
 * One check ran and found nothing. Kept so the page can say 放行 rather than 未检查.
 */
export function recordCheck(state, check = {}) {
  state.lastResult = {
    at: new Date().toISOString(),
    rule: check.rule ? String(check.rule) : null,
    title: check.title ? String(check.title) : '',
    target: check.target ? String(check.target) : '',
    verdict: 'allow',
  };
  return state.lastResult;
}

/**
 * One finding was observed. Observe mode and protect mode both land here; only protect
 * mode then denies. Repeated dumps of the same call never overwrite the first record.
 */
export function recordFinding(state, finding = {}, verdict = 'deny') {
  const at = finding.at ? String(finding.at) : new Date().toISOString();
  const entry = {
    at,
    rule: finding.rule ? String(finding.rule) : '?',
    title: finding.title ? String(finding.title) : '',
    target: finding.target ? String(finding.target) : '',
    reason: finding.reason ? String(finding.reason) : '',
    verdict: verdict === 'observe' ? 'observe' : 'deny',
    key: finding.callId ? String(finding.callId) : '',
  };
  const key = entry.key || `${entry.rule}|${entry.target}|${at}`;
  if (state.denialKeys.has(key)) {
    const existing = state.denials.find((item) => item.key === key || item.at === at && item.rule === entry.rule && item.target === entry.target);
    if (existing) existing.hits += 1;
    return { entry: existing ?? entry, duplicate: true };
  }
  entry.hits = 1;
  state.denialKeys.add(key);
  state.denials.push(entry);
  if (state.denials.length > MAX_DENIALS) {
    const dropped = state.denials.shift();
    if (dropped) state.denialKeys.delete(dropped.key || `${dropped.rule}|${dropped.target}|${dropped.at}`);
  }
  state.lastResult = { at: entry.at, rule: entry.rule, title: entry.title, target: entry.target, verdict: entry.verdict };
  return { entry, duplicate: false };
}

/** Record an exception from a hook body without losing the last real result. */
export function recordError(state, error) {
  state.lastError = error ? String(error.message ?? error) : null;
  return state.lastError;
}

/**
 * Whether this call's denial still has to reach the originating session.
 * Keyed by the subcall id, so a re-dump of the same denial is never re-sent.
 */
export function claimFeedback(state, callId) {
  const key = callId ? String(callId) : '';
  if (!key) return false;
  if (state.ledger.has(key)) return false;
  state.ledger.add(key);
  if (state.ledger.size > MAX_LEDGER) {
    const first = state.ledger.values().next().value;
    if (first !== undefined) state.ledger.delete(first);
  }
  return true;
}

export function hasFeedback(state, callId) {
  return state.ledger.has(String(callId ?? ''));
}

/** The denial recorded for one call id, so post-execute can report the real reason. */
export function denialFor(state, callId) {
  const key = callId ? String(callId) : '';
  if (!key) return null;
  for (let index = state.denials.length - 1; index >= 0; index -= 1) {
    if (state.denials[index].key === key) return state.denials[index];
  }
  return null;
}

function capabilityOf(state) {
  if (state.mode === 'off') return 'off';
  if (state.lastError) return 'error';
  const wired = LAYERS.filter((layer) => state.hooks[layer]);
  if (wired.length === LAYERS.length) return 'normal';
  if (wired.length > 0) return 'partial';
  return 'unavailable';
}

function coverageOf(state) {
  const coverage = {};
  for (const layer of LAYERS) coverage[layer] = state.hooks[layer] ? 'full' : 'off';
  return coverage;
}

/** Everything the guard tool and a future settings page need, derived once. */
export function snapshot(state = defenseRuntime()) {
  const capability = capabilityOf(state);
  return {
    mode: state.mode,
    modeLabel: MODE_LABELS[state.mode],
    enabled: state.mode !== 'off',
    monitorOnly: state.mode === 'observe',
    hooks: { ...state.hooks },
    coverage: coverageOf(state),
    capability,
    capabilityLabel: CAPABILITY_LABELS[capability],
    lastResult: state.lastResult ? { ...state.lastResult } : null,
    lastError: state.lastError,
    denials: state.denials.map((entry) => ({ ...entry })),
    denialCount: state.denials.length,
  };
}

function targetText(result) {
  if (!result?.target) return '';
  return ` → ${result.target}`;
}

/**
 * Status lines, one sentence per line. Pure: the tool card, the status page and tests all
 * read the same strings so the page never invents a second truth.
 */
export function describeStatus(state = defenseRuntime()) {
  const info = snapshot(state);
  const lines = [`模式 ${info.modeLabel}`];
  lines.push(`实际状态 ${info.capabilityLabel}`);

  const wired = LAYERS.filter((layer) => info.hooks[layer]).length;
  if (info.mode === 'off') {
    lines.push('覆盖范围 未挂载检查，改动不受检查');
  } else if (wired === LAYERS.length) {
    lines.push('覆盖范围 写前检查、安装前预检');
  } else if (info.hooks.write) {
    lines.push('覆盖范围 只有写前检查，安装前预检未接上');
  } else if (info.hooks.preExecute) {
    lines.push('覆盖范围 只有安装前预检，写前检查未接上');
  } else if (info.capability === 'error') {
    lines.push(`覆盖范围 检查报错：${info.lastError}`);
  } else {
    lines.push('覆盖范围 没有接上检查，重启后仍未接上就关掉这个插件');
  }

  const last = info.lastResult;
  if (!last) {
    lines.push('最近一次检查 未检查');
  } else if (last.verdict === 'deny') {
    lines.push(`最近一次检查 已阻止 ${last.rule}${targetText(last)}`);
  } else if (last.verdict === 'observe') {
    lines.push(`最近一次检查 观察到风险 ${last.rule}${targetText(last)}`);
  } else {
    lines.push(`最近一次检查 放行${targetText(last)}`);
  }
  return lines;
}

/** The most recent denials, newest first. */
export function recentDenials(state = defenseRuntime(), limit = 5) {
  const size = Math.max(1, Math.min(MAX_DENIALS, Number(limit) || 5));
  return state.denials.slice(-size).reverse().map((entry) => ({ ...entry }));
}
