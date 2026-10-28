/**
 * Live defense: refuse a tool call before its side effect when the proposed change is
 * a known crash shape for the running profile.
 *
 * Two host mechanisms, used for what each is good at:
 * - `tools/pre-execute` (async, waterfall): read the candidate source, run the static
 *   preflight, deny with a reason. Runs on plugin install / enable.
 * - `ctx.tools.guard()` (sync, monotonic): cheap checks on the proposed text of a
 *   write/edit into a file the running host actually loads. Nothing can force-allow it.
 *
 * Everything fails open: a defense plugin must not take the host down, and must not
 * block ordinary development. Only shapes proven to crash this machine are refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pluginIndex } from './core.mjs';
import { preflight, lastSyntaxStatus, syntaxErrorFor } from './guard.mjs';
import { inspectText as judgeText } from './lib/judge.mjs';
import {
  canonicalPath,
  entryIndex,
  isInside,
  resolveBundleTarget,
  resolveFileTarget,
  resolvePluginTarget,
  sessionCwd,
} from './lib/resolve.mjs';

/** Rule ids solid enough to refuse an install: no spread/loader false positives. */
const BLOCKING = new Set([
  'P001', 'P002', 'P005', 'P007', 'P008', 'P009', 'P010',
  'P013', 'P014', 'P016', 'P018', 'P019', 'P021',
]);

const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/;

/** File kinds whose proposed text is worth judging. */
const JUDGED = new Set(['plugin-source', 'plugin-manifest', 'profile-patch', 'profile-manifest']);

/** Surfaces are refreshed in place at most this often. */
const REFRESH_MS = 2000;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** One stat per refresh decision; any failure keeps the previous snapshot. */
function probeKey(file) {
  if (!file) return 'none';
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function pluginRecords(dir) {
  return pluginIndex(dir)
    .filter((entry) => entry.dir && fs.existsSync(entry.dir))
    .map((entry) => ({ name: entry.name, dir: entry.dir, real: canonicalPath(entry.dir), linked: !dir || !isInside(entry.dir, dir), enabled: true }));
}

/** Tag each plugin record with the entry ids and enabled state the loader sees. */
function annotate(surfaces) {
  try {
    const map = entryIndex(surfaces);
    const byDir = new Map();
    for (const entry of map.values()) {
      const key = canonicalPath(entry.dir);
      if (!byDir.has(key)) byDir.set(key, []);
      byDir.get(key).push(entry);
    }
    for (const plugin of surfaces.plugins) {
      const rows = byDir.get(plugin.real || canonicalPath(plugin.dir)) || [];
      plugin.entryIds = rows.map((row) => row.id);
      /* a dependency nothing declares an entry for is loaded by the base composition: enabled */
      plugin.enabled = rows.length ? rows.some((row) => row.enabled) : true;
    }
  } catch {
    for (const plugin of surfaces.plugins) plugin.enabled = plugin.enabled !== false;
  }
}

function rebuild(surfaces, dir) {
  if (!dir) {
    surfaces.profileDir = '';
    surfaces.profileReal = '';
    surfaces.plugins = [];
    surfaces.patchFile = '';
    surfaces.pkgFile = '';
    return surfaces;
  }
  surfaces.profileDir = path.resolve(dir);
  surfaces.profileReal = canonicalPath(surfaces.profileDir);
  surfaces.patchFile = path.join(surfaces.profileDir, 'cordis.patch.yml');
  surfaces.pkgFile = path.join(surfaces.profileDir, 'package.json');
  surfaces.plugins = pluginRecords(surfaces.profileDir);
  surfaces._entries = null;
  annotate(surfaces);
  surfaces.stale = false;
  return surfaces;
}

/**
 * Which live surfaces the running host loads, and where a file sits relative to them.
 * @param {string} profileDir
 * @returns {{profileDir:string, plugins:Array<{name:string,dir:string,linked:boolean,enabled:boolean}>, patchFile:string, pkgFile:string, stale:boolean, refreshedAt:number}}
 */
export function liveSurfaces(profileDir = process.env.DSH_PROFILE_DIR || '') {
  const surfaces = {
    profileDir: '',
    profileReal: '',
    plugins: [],
    patchFile: '',
    pkgFile: '',
    stale: false,
    refreshedAt: Date.now(),
    _probeKey: '',
    _dirty: false,
    _entries: null,
  };
  rebuild(surfaces, profileDir ? path.resolve(profileDir) : '');
  surfaces._probeKey = probeKey(surfaces.pkgFile);
  surfaces.refreshedAt = Date.now();
  return surfaces;
}

/**
 * Refresh the surface snapshot in place, so hook closures created at activation see
 * plugins installed/enabled/disabled later. Throttled: at most one stat per call, and
 * only when the last refresh is older than REFRESH_MS (or a change was just made).
 * A failed stat keeps the previous values and marks them `stale` — never a reason to deny.
 * @returns {ReturnType<typeof liveSurfaces>}
 */
export function refreshSurfaces(surfaces, profileDir = surfaces?.profileDir) {
  if (!surfaces || typeof surfaces !== 'object') return surfaces;
  const now = Date.now();
  if (typeof surfaces.refreshedAt !== 'number') surfaces.refreshedAt = now;
  const dirty = surfaces._dirty === true;
  if (!dirty && now - surfaces.refreshedAt <= REFRESH_MS) return surfaces;
  surfaces._dirty = false;
  try {
    const dir = profileDir || surfaces.profileDir;
    const next = probeKey(surfaces.pkgFile || (dir ? path.join(dir, 'package.json') : ''));
    if (!dirty && next === surfaces._probeKey && surfaces.plugins.length) {
      surfaces.refreshedAt = now;
      surfaces.stale = false;
      return surfaces;
    }
    rebuild(surfaces, dir);
    surfaces._probeKey = probeKey(surfaces.pkgFile);
    surfaces.refreshedAt = now;
  } catch {
    /* keep the previous snapshot; a stale snapshot is not a reason to block anything */
    surfaces.stale = true;
    surfaces.refreshedAt = now;
  }
  return surfaces;
}

/** Mark the snapshot as needing a rebuild before the next guard decision. */
export function markSurfacesDirty(surfaces) {
  if (surfaces && typeof surfaces === 'object') surfaces._dirty = true;
  return surfaces;
}

/**
 * Crash shapes detectable in one file, without a subprocess. Delegates to the same
 * implementation the CLI uses, so `crash-lore check` and the live guard cannot disagree.
 * @param {string} text proposed file content
 * @param {string} file absolute path the content would be written to
 * @returns {null | {ruleId:string, title:string, line:number, message:string, fix:string, snippet:string}}
 */
export function inspectText(text, file, options = {}) {
  return judgeText(text, file, options);
}

/**
 * Classify a path as a live host surface. Linked dev trees count as live because the
 * host loads them through symlink; `linked` lets callers keep dev-friendly behavior.
 * `enabled` reports whether the loader currently activates it.
 * @param {string} file
 * @param {ReturnType<typeof liveSurfaces>} surfaces
 */
export function classify(file, surfaces) {
  if (!file || !surfaces) return { live: false };
  const target = canonicalPath(file);
  if (surfaces.pkgFile && target === canonicalPath(surfaces.pkgFile)) return { live: true, kind: 'profile-manifest', name: 'profile' };
  if (surfaces.patchFile && target === canonicalPath(surfaces.patchFile)) return { live: true, kind: 'profile-patch', name: 'profile' };
  for (const entry of surfaces.plugins) {
    /* a disabled entry is not loaded, so its files are ordinary work again */
    if (entry.enabled === false) continue;
    const root = entry.real || (entry.real = canonicalPath(entry.dir));
    if (!(target === root || target.startsWith(`${root}${path.sep}`))) continue;
    const rel = path.relative(root, target).split(path.sep).join('/');
    const base = { live: true, name: entry.name, dir: root, rel, linked: entry.linked, enabled: entry.enabled !== false };
    if (/(?:^|\/)(?:cordis\.patch\.yml|package\.json)$/.test(rel)) return { ...base, kind: 'plugin-manifest' };
    if (CODE.test(rel)) return { ...base, kind: 'plugin-source' };
    return { ...base, kind: 'plugin-other' };
  }
  const profileReal = surfaces.profileReal || (surfaces.profileDir ? canonicalPath(surfaces.profileDir) : '');
  if (profileReal && (target === profileReal || target.startsWith(`${profileReal}${path.sep}`))) return { live: true, kind: 'profile-other', name: 'profile' };
  return { live: false };
}

/** Reconstruct the file a write/edit would leave behind. */
export function proposedText(name, args, read = readTextSafe) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'write' || name === 'Write') return typeof args.content === 'string' ? { file: args.file_path ?? args.path, text: args.content } : null;
  if (name === 'edit' || name === 'Edit') {
    const file = args.file_path ?? args.path;
    const before = typeof file === 'string' ? read(file) : null;
    if (before == null) return null;
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null;
    if (!args.old_string) return null;
    if (args.replace_all === true) return { file, text: before.split(args.old_string).join(args.new_string) };
    const at = before.indexOf(args.old_string);
    if (at < 0) return null;
    return { file, text: `${before.slice(0, at)}${args.new_string}${before.slice(at + args.old_string.length)}` };
  }
  return null;
}

/** Read for edit: a relative path is read from the originating session's directory. */
function resolverRead(exec, options) {
  const { agent } = exec ?? {};
  const { cwd } = options;
  return (file) => {
    const target = resolveFileTarget(file, { agent, cwd });
    const abs = target.file || file;
    return readTextSafe(abs);
  };
}

/** The refusal text the calling agent receives as this call's error result. */
export function blockReason({ surface, finding, file, action }) {
  const where = surface?.name && surface.name !== 'profile' ? `插件：${surface.name}\n` : '';
  const loc = file ? `${file}${finding.line ? `:${finding.line}` : ''}` : 'profile';
  const lines = [
    '[CRASH_LORE_BLOCKED] 本次操作未执行。',
    '',
    `${where}位置：${loc}`,
    `规则：${finding.ruleId} ${finding.title}`,
    `原因：${finding.message}`,
  ];
  if (finding.snippet) lines.push(`证据：${finding.snippet}`);
  lines.push(`风险：这一步会在 running profile 里生效，宿主激活/热重载时崩溃，当前所有会话一起掉线。`);
  lines.push(`建议：${finding.fix}`);
  if (action) lines.push(`改好后重新提交这次${action}；你仍可以继续读代码、改开发副本、跑测试。`);
  else lines.push('改好后重新提交；你仍可以继续读代码、改开发副本、跑测试。');
  return lines.join('\n');
}

/** Refusal for a target whose real location cannot be attributed to a directory. */
export function unresolvedReason(raw, action = '写入') {
  return [
    '[CRASH_LORE_BLOCKED] 本次操作未执行。',
    '',
    `位置：${raw}`,
    '规则：unresolved 目标路径无法判定',
    '原因：这是相对路径，但拿不到发起这次调用的会话工作目录，因此无法判断它会不会落进宿主正在加载的插件。按一个猜的目录放行，等于没检查。',
    `建议：改成绝对路径重新提交这次${action}，或先切到目标目录再写；你仍可以继续读代码、改开发副本、跑测试。`,
  ].join('\n');
}

export function denial(reason, finding) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'CrashLoreBlocked',
      code: 'CRASH_LORE_BLOCKED',
      rule: finding?.ruleId,
      title: finding?.title,
    },
  };
}

/**
 * Sync guard: refuse write/edit whose resulting text is a known crash shape in a live file.
 * @returns {string|undefined} denial reason, or undefined to allow
 */
export function guardWrite(exec, options = {}) {
  const name = exec?.name;
  if (name !== 'write' && name !== 'Write' && name !== 'edit' && name !== 'Edit') return undefined;
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  try {
    refreshSurfaces(surfaces, options.profileDir);
  } catch {
    /* a stale snapshot is not a reason to block a healthy edit */
  }
  const proposed = proposedText(name, exec.arguments, options.read ?? resolverRead(exec, options));
  if (!proposed || !proposed.file || typeof proposed.text !== 'string') return undefined;
  const target = resolveFileTarget(proposed.file, { agent: exec.agent, cwd: options.cwd });
  if (!target.file) {
    const finding = { ruleId: 'unresolved', title: '目标路径无法判定', line: 0 };
    const surface = { name: 'profile' };
    const reason = unresolvedReason(proposed.file, '写入');
    options.onDeny?.(finding, surface, String(proposed.file), reason);
    return reason;
  }
  const surface = classify(target.file, surfaces);
  if (!surface.live) return undefined;
  if (!JUDGED.has(surface.kind)) return undefined;
  let finding = inspectText(proposed.text, target.file, { rel: surface.rel });
  if (!finding && surface.kind === 'plugin-source' && /\.(?:mjs|cjs|js|mts|cts)$/i.test(target.file)) {
    const broken = syntaxErrorFor(target.file, proposed.text);
    if (broken) {
      finding = {
        ruleId: 'P013',
        title: '文件语法不合法（写进去必然激活失败）',
        severity: 'boot',
        line: broken.line,
        message: broken.message,
        fix: '先修好语法再写进 live 插件',
      };
    }
  }
  if (!finding) return undefined;
  const reason = blockReason({ surface, finding, file: target.file, action: '写入' });
  options.onDeny?.(finding, surface, target.file, reason);
  return reason;
}

/** Destructive shell commands whose *target* is a live root (or a parent of one). */
const DESTRUCTIVE = /(?:^|[;&|]\s*)(?:rm|rmdir|mv|trash|unlink|shred)\b/;

function shellTargets(command, cwd) {
  const text = String(command ?? '').replace(/\s+/g, ' ');
  if (!DESTRUCTIVE.test(text)) return [];
  const targets = [];
  for (const match of text.matchAll(/(?:^|[;&|]\s*)(?:rm|rmdir|mv|trash|unlink|shred)\s+([^;&|]+)/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (!token || token.startsWith('-')) continue;
      const cleaned = token.replace(/^['"]|['"]$/g, '');
      if (!cleaned || cleaned.includes('*')) continue;
      targets.push(path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned));
    }
  }
  return targets;
}

/**
 * Sync guard: refuse a destructive shell command aimed at a live root, or at a directory
 * that contains one. Single files inside a live tree are ordinary development.
 * @returns {string|undefined} denial reason, or undefined to allow
 */
export function guardShell(exec, options = {}) {
  const name = exec?.name;
  if (name !== 'bash' && name !== 'Bash' && name !== 'shell' && name !== 'Shell') return undefined;
  const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
  if (!command) return undefined;
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  try {
    refreshSurfaces(surfaces, options.profileDir);
  } catch {
    /* fail open */
  }
  const argvCwd = exec.arguments?.cwd ?? exec.arguments?.workdir;
  const cwd = argvCwd ?? options.cwd ?? sessionCwd(exec.agent).cwd ?? process.cwd();
  const targets = shellTargets(command, cwd);
  if (!targets.length) return undefined;
  const roots = [surfaces.profileReal || surfaces.profileDir, ...surfaces.plugins.filter((entry) => entry.enabled !== false).map((entry) => entry.real || entry.dir)]
    .filter(Boolean)
    .map((root) => canonicalPath(root));
  for (const target of targets) {
    const real = canonicalPath(target);
    const live = roots.find((root) => real === root || root.startsWith(`${real}${path.sep}`));
    if (!live) continue;
    const lines = [
      '[CRASH_LORE_BLOCKED] 本次操作未执行。',
      '',
      `位置：${target}`,
      '规则：live-delete 删/移动了宿主正在加载的目录',
      `原因：${target} 是 running profile 的插件根（或包含插件根）。宿主的加载器盯着这些目录，热重载会立刻按缺失的入口重新激活，全部会话一起掉线。`,
      '风险：插件目录消失后宿主无法回退，只能重启才能恢复。',
      '建议：只删目录里的单个文件没有关系；确实要移除整个插件，用 plugin_manager 的 remove_bundle/set_plugin 走宿主卸载流程。',
      '你仍可以继续读代码、改开发副本、跑测试。',
    ];
    return lines.join('\n');
  }
  return undefined;
}

/** The directory a plugin_manager target will be loaded from. */
export function candidateDir(args, surfaces = liveSurfaces()) {
  const target = typeof args?.target === 'string' ? args.target.trim() : '';
  if (!target) return null;
  const resolved = resolvePluginTarget(args, surfaces);
  if (resolved.dir) return resolved.dir;
  const spec = /^(?:link|file):(.+)$/.exec(target);
  if (spec) {
    const dir = path.resolve(surfaces.profileDir || process.cwd(), spec[1]);
    return fs.existsSync(dir) ? dir : null;
  }
  return null;
}

function uniqueDirs(entries) {
  const seen = new Set();
  const dirs = [];
  for (const entry of entries) {
    if (!entry?.dir || seen.has(entry.dir)) continue;
    seen.add(entry.dir);
    dirs.push(entry.dir);
  }
  return dirs;
}

let lastPreflight = { checked: 0, cached: 0, unchecked: 0, budgetHit: false, dir: null };
const INSTALL_BUDGET_MS = 3000;

/** What the last install-time preflight actually parsed; callers must not claim more. */
export function lastPreflightStatus() {
  return { ...lastPreflight };
}

/**
 * Install-time preflight is fail-closed, unlike the write guard: a candidate whose entry
 * files could not all be parsed is not a candidate that was checked. One bounded retry
 * (the cache keeps what the first pass finished), then an explicit `uninspected` refusal.
 */
export function preflightCandidate(dir, budgetMs = INSTALL_BUDGET_MS) {
  if (!dir || !fs.existsSync(dir)) return { finding: null, status: { ...lastSyntaxStatus(), dir } };
  let findings = [];
  let status = null;
  try {
    findings = preflight(dir, { budgetMs });
    status = lastSyntaxStatus();
    if (status.unchecked > 0) {
      findings = preflight(dir, { budgetMs });
      status = lastSyntaxStatus();
    }
  } catch (error) {
    /* A preflight that crashed did not check anything: refusing is the only honest answer for an
     * install, otherwise an unreadable candidate would be installed as if it had been inspected. */
    const message = String(error?.message || error || '预检失败');
    lastPreflight = { ...lastSyntaxStatus(), dir, error: message };
    return {
      finding: {
        ruleId: 'uninspected',
        severity: 'boot',
        title: '预检失败，未检查的内容不能当作已通过',
        file: '',
        line: 0,
        message: `检查候选插件时出错（${message}），这次安装被拒绝。`,
        fix: '先在本地跑 node cli.mjs check <插件目录> 看清具体错误；确认可读后再重试安装。',
      },
      status: { ...lastPreflight },
    };
  }
  lastPreflight = { ...status, dir };
  const blocking = findings.find((finding) => BLOCKING.has(finding.ruleId));
  if (blocking) return { finding: blocking, status };
  if (status.unchecked > 0) {
    return {
      finding: {
        ruleId: 'uninspected',
        severity: 'boot',
        title: '预检未完成，未检查的内容不能当作已通过',
        file: '',
        line: 0,
        message: `有 ${status.unchecked} 个入口文件未能在 ${budgetMs}ms 预算内完成语法检查（含一次重试），所以这次安装被拒绝。`,
        fix: '机器负载降下来后重试；或者把插件拆小，让入口文件数量/体积落在预算内；先在本地跑 node cli.mjs check <插件目录> 确认没有致命问题。',
      },
      status,
    };
  }
  return { finding: null, status };
}

function firstBlocking(dir, budgetMs) {
  return preflightCandidate(dir, budgetMs).finding;
}

/** Refusal for a bundle whose enabled content cannot be opened at all. */
function uninspectedReason(target) {
  return [
    '[CRASH_LORE_BLOCKED] 本次操作未执行。',
    '',
    `目标：${target}`,
    '规则：uninspected 未检查',
    '原因：这个 bundle 的启用内容在本地找不到可读的模块目录，因此无法在启用前确认它会不会让宿主起不来。没有检查就放行，等于把风险直接装进 running profile。',
    '建议：三种做法任选其一，做完再提交这次启用：',
    '1) 先把 bundle 装进 profile（plugin_manager install_bundle），让它的模块目录落在 profile 里，再启用；',
    '2) 在本地准备一个候选副本（复制到临时目录或 link: 到你的开发目录），先用 crash-lore 的 check 跑一遍，确认没有致命/起不来问题；',
    '3) 只想先在别的机器或空 profile 试，就在那边启用，把结果带回来。',
    '你仍可以继续读代码、改开发副本、跑测试。',
  ].join('\n');
}

/**
 * Async pre-execute: gate anything that puts a candidate into the running profile.
 * @returns {Promise<undefined | ReturnType<typeof denial>>}
 */
export async function preExecute(exec, options = {}) {
  const name = exec?.name;
  if (name !== 'plugin_manager') return undefined;
  const args = exec?.arguments ?? {};
  const action = typeof args.action === 'string' ? args.action : '';
  const enabled = args.enabled !== false;
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  try {
    refreshSurfaces(surfaces, options.profileDir);
  } catch {
    /* fail open */
  }

  const mutating = action === 'install_bundle' || action === 'remove_bundle' || action === 'set_bundle' || action === 'set_plugin';

  /* set_bundle: the bundle name is not an entry id, so inspect every entry it contributes */
  if (action === 'set_bundle' && enabled) {
    const bundle = resolveBundleTarget(args.target, surfaces);
    const dirs = uniqueDirs(bundle.entries);
    for (const dir of dirs) {
      const finding = firstBlocking(dir, options.installBudgetMs);
      if (!finding) continue;
      const surface = { name: args.target };
      const reason = blockReason({ surface, finding, file: path.join(dir, finding.file || ''), action: '启用' });
      options.onDeny?.(finding, surface, dir, reason);
      return denial(reason, finding);
    }
    if (!dirs.length) {
      const finding = { ruleId: 'uninspected', title: '启用内容未检查', line: 0 };
      const surface = { name: args.target };
      const reason = uninspectedReason(args.target);
      options.onDeny?.(finding, surface, args.target, reason);
      return denial(reason, finding);
    }
    markSurfacesDirty(surfaces);
    return undefined;
  }

  /* install_bundle / set_plugin(enabled): one candidate directory to preflight */
  const installing = action === 'install_bundle' || (action === 'set_plugin' && enabled);
  if (installing) {
    const dir = candidateDir(args, surfaces);
    if (dir) {
      const finding = firstBlocking(dir, options.installBudgetMs);
      if (finding) {
        const surface = { name: path.basename(dir) };
        const reason = blockReason({ surface, finding, file: path.join(dir, finding.file || ''), action: '安装' });
        options.onDeny?.(finding, surface, dir, reason);
        return denial(reason, finding);
      }
    }
  }

  if (mutating) markSurfacesDirty(surfaces);
  return undefined;
}

export const DEFENSE_DEFAULTS = { guard: true, monitorOnly: false };
export { BLOCKING };
