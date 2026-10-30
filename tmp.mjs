import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 崩溃排查会把会话快照复制到临时目录；一份就是几百 MB，没人清就会把磁盘吃满（本机真吃到 58 GB）。
 * 只清自己造的那几种前缀，别人的文件一律不碰。 */
export const TEMP_PREFIXES = ['lifeguard-sessions-', 'crash-lore-sessions-', 'lifeguard-handoff-', 'crash-lore-handoff-'];
export const DEFAULT_BUDGET_MB = 5120;
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 30 * 60 * 1000;
/* 刚建出来的快照可能正被别的进程写着，太新的不删，只按预算兜底。 */
export const MIN_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_DEPTH = 6;

function isOurs(name) {
  return TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/* 目录大小按 stat 累加，不读内容；单条出错就当 0，清理不是审计。 */
function sizeOf(dir) {
  let total = 0;
  let seen = 0;
  const walk = (current, depth) => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen > MAX_ENTRIES) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      seen += 1;
      try {
        total += fs.statSync(full).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(dir, 0);
  return total;
}

/** 临时目录里属于自己的会话快照，最近的在前。 */
export function listTemp(roots = [os.tmpdir()]) {
  const found = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isOurs(entry.name)) continue;
      const dir = path.join(root, entry.name);
      let stat = null;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      found.push({ dir, name: entry.name, mtimeMs: stat.mtimeMs, bytes: sizeOf(dir) });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/**
 * 按「超期」和「超预算」两把尺子清：先删最老的，删到预算内为止；保护名单里的不动。
 * @param {object} options
 */
export function sweepTemp(options = {}) {
  const now = Number(options.now) || Date.now();
  const budgetMB = Number.isFinite(options.budgetMB) && options.budgetMB > 0 ? options.budgetMB : DEFAULT_BUDGET_MB;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const protect = new Set((options.protect ?? []).filter(Boolean).map((dir) => path.resolve(String(dir))));
  const dryRun = options.dryRun === true;
  const entries = listTemp(options.roots);
  const stale = entries.filter((entry) => now - entry.mtimeMs > ttlMs);
  const removable = (entry) => !protect.has(path.resolve(entry.dir)) && now - entry.mtimeMs > MIN_AGE_MS;
  const doomed = new Set(stale.filter(removable));
  let keptMB = Math.round(entries.reduce((sum, entry) => sum + entry.bytes, 0) / (1024 * 1024));
  const budget = Math.round(budgetMB);
  if (keptMB > budget) {
    for (const entry of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (keptMB <= budget) break;
      if (!removable(entry) || doomed.has(entry)) continue;
      doomed.add(entry);
      keptMB -= Math.round(entry.bytes / (1024 * 1024));
    }
  }
  let freedBytes = 0;
  let removed = 0;
  for (const entry of doomed) {
    if (!dryRun) {
      try {
        fs.rmSync(entry.dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        continue;
      }
    }
    freedBytes += entry.bytes;
    removed += 1;
  }
  return {
    removed,
    kept: entries.length - removed,
    freedMB: Math.round(freedBytes / (1024 * 1024)),
    keptMB: Math.max(0, Math.round((entries.reduce((sum, entry) => sum + entry.bytes, 0) - freedBytes) / (1024 * 1024))),
    budgetMB: budget,
    dryRun,
  };
}

let lastSweep = 0;

/** 定时器用：两把尺子里最长 30 分钟扫一次，跑失败不抛。 */
export function maybeSweep(options = {}) {
  const now = Number(options.now) || Date.now();
  if (lastSweep && now - lastSweep < SWEEP_EVERY_MS) return null;
  lastSweep = now;
  try {
    const result = sweepTemp({ ...options, now });
    return result.removed > 0 ? result : null;
  } catch {
    return null;
  }
}

export function resetSweepClock() {
  lastSweep = 0;
}
