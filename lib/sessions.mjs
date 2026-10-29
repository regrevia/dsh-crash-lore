/**
 * Session footprint: the one memory driver this plugin can measure before the host dies.
 *
 * A heap death leaves no plugin stack, because the memory is not a plugin's: the host restores
 * every open session by replaying its transcript into live objects. A 67 MB packed transcript is
 * ~238 MB of JSONL and, once parsed, several times that. Three such sessions open at boot is a
 * multi-GB spike inside a ~4 GB ceiling.
 *
 * This module only measures and reports: it never closes, never truncates, never deletes a
 * session. A stale lock is reported as stale, not treated as open. Sizes are estimates with the
 * ratios stated, because the honest information here is the order of magnitude.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** A lock older than this was left behind by a dead host, not held by a live one. */
export const LOCK_FRESH_MS = 15 * 60 * 1000;
/** Measured on this machine: packed zstd → JSONL plaintext. */
export const PLAIN_RATIO = 3.6;
/** Measured on this machine: packed zstd → host heap at restore (547 MB packed ≈ 3.3 GB peak). */
export const RESTORE_FACTOR = 6.2;
const TRANSCRIPT = 'session.v4.jsonl.zstd';

function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function megabytes(bytes) {
  return Math.round((Number(bytes) || 0) / (1024 * 1024));
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function walkSessions(root) {
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const found = [];
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const dir = path.join(projectDir, session.name);
      const transcript = safeStat(path.join(dir, TRANSCRIPT));
      if (!transcript) continue;
      found.push({ project: project.name, id: session.name, dir, packedBytes: transcript.size });
    }
  }
  return found;
}

/**
 * @param {string} [home] DSH home (`~/.dsh`)
 * @param {{now?: number, freshMs?: number, limit?: number}} [options]
 * @returns {{open: object[], stale: object[], totalPackedMB: number, openPackedMB: number, estimateGB: number, ceilingRisk: boolean}}
 */
export function sessionFootprint(home = defaultHome(), options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const freshMs = Number(options.freshMs) || LOCK_FRESH_MS;
  const limit = Number(options.limit) || 8;
  const root = path.join(home, 'sessions');
  const open = [];
  const stale = [];
  for (const entry of walkSessions(root)) {
    const lock = safeStat(path.join(entry.dir, 'session.lock'));
    if (!lock) continue;
    const ageMs = now - lock.mtimeMs;
    const row = {
      project: entry.project,
      id: entry.id,
      packedMB: megabytes(entry.packedBytes),
      plainMB: megabytes(entry.packedBytes * PLAIN_RATIO),
      estimateMB: megabytes(entry.packedBytes * RESTORE_FACTOR),
      lockedAt: new Date(lock.mtimeMs).toISOString(),
      ageMs,
    };
    if (ageMs <= freshMs) open.push(row);
    else stale.push(row);
  }
  open.sort((a, b) => b.packedMB - a.packedMB);
  stale.sort((a, b) => b.packedMB - a.packedMB);
  const openPackedMB = open.reduce((sum, row) => sum + row.packedMB, 0);
  const totalPackedMB = openPackedMB + stale.reduce((sum, row) => sum + row.packedMB, 0);
  const estimateGB = Math.round((openPackedMB * RESTORE_FACTOR / 1024) * 10) / 10;
  return {
    open: open.slice(0, limit),
    stale: stale.slice(0, limit),
    openCount: open.length,
    staleCount: stale.length,
    openPackedMB,
    totalPackedMB,
    estimateGB,
    ceilingRisk: estimateGB >= 2,
  };
}

function shortProject(project) {
  const parts = String(project || '').split('-').filter(Boolean);
  return parts.slice(-2).join('/') || String(project || '');
}

/**
 * One status line for the guard card and the scan summary. Empty when nothing is open, so the
 * card stays quiet on an idle machine.
 */
export function footprintLines(footprint) {
  if (!footprint || (!footprint.openCount && !footprint.staleCount)) return [];
  const lines = [];
  if (footprint.openCount) {
    const names = footprint.open.slice(0, 3).map((row) => `${shortProject(row.project)} ${row.packedMB} MB`);
    lines.push(
      `宿主刚碰过 ${footprint.openCount} 个会话（${names.join('、')}${footprint.openCount > 3 ? ' …' : ''}）：恢复时约占 ${footprint.estimateGB} GB 堆，用不到的先关。`,
    );
  }
  if (footprint.staleCount) {
    lines.push(`另有 ${footprint.staleCount} 个会话留有旧锁（宿主已退出），不算占用。`);
  }
  return lines;
}

/* ---------------------------------------------------------------- history */

/* A footprint read at scan time is the footprint *now*. To say what the machine carried when it
 * died, the number has to have been written before the death. The live watchdog samples it on its
 * slow tick, so an OOM row can quote the last snapshot taken while the host was still alive. */
const MAX_HISTORY_BYTES = 256 * 1024;
/* 288 samples = one day at the 5-minute cadence, ~60 KB: the file never grows without a bound. */
const KEEP_LINES = 288;

export function footprintSample(home = defaultHome(), options = {}) {
  const at = typeof options.now === 'number' ? options.now : Date.now();
  const snap = sessionFootprint(home, { ...options, now: at });
  return {
    t: new Date(at).toISOString(),
    openCount: snap.openCount,
    staleCount: snap.staleCount,
    openPackedMB: snap.openPackedMB,
    estimateGB: snap.estimateGB,
    top: snap.open.slice(0, 3).map((row) => ({ project: shortProject(row.project), packedMB: row.packedMB })),
  };
}

/** Append one sample. Best effort: a failed write must never disturb the host. */
export function recordFootprint(home = defaultHome(), options = {}) {
  try {
    /* Same location core.mjs exposes as paths(home).footprint; spelled out here to keep the
     * footprint module free of a cycle with core. */
    const file = path.join(home, 'crash-lore', 'footprint.jsonl');
    const sample = footprintSample(home, options);
    let existing = '';
    try {
      const stat = safeStat(file);
      if (stat && stat.size > MAX_HISTORY_BYTES) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
        existing = `${kept.join('\n')}\n`;
      }
    } catch {
      existing = '';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${existing}${JSON.stringify(sample)}\n`);
    return sample;
  } catch {
    return null;
  }
}

/** Newest sample written at or before `iso`, within `maxAgeMs`. Null when nothing was recorded. */
export function footprintBefore(home = defaultHome(), iso, options = {}) {
  const at = Date.parse(String(iso));
  if (!Number.isFinite(at)) return null;
  const maxAgeMs = Number(options.maxAgeMs) || 6 * 60 * 60 * 1000;
  let text = '';
  try {
    text = fs.readFileSync(path.join(home, 'crash-lore', 'footprint.jsonl'), 'utf8');
  } catch {
    return null;
  }
  let best = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(String(row?.t));
    if (!Number.isFinite(t) || t > at) continue;
    if (!best || t > Date.parse(best.t)) best = row;
  }
  if (!best || at - Date.parse(best.t) > maxAgeMs) return null;
  return { ...best, ageMin: Math.round((at - Date.parse(best.t)) / 60000) };
}

/** One line of OOM evidence: how much the machine was already carrying before it died. */
export function oomEvidenceLines(evidence) {
  if (!evidence) return [];
  const where = evidence.top?.length
    ? `（${evidence.top.map((row) => `${row.project} ${row.packedMB} MB`).join('、')}${evidence.openCount > 3 ? ' …' : ''}）`
    : '';
  return [
    `崩前 ${evidence.ageMin <= 1 ? '不到 1' : evidence.ageMin} 分钟：${evidence.openCount} 个会话开着，恢复时估 ${evidence.estimateGB} GB 堆${where}。`,
  ];
}
