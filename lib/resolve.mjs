/**
 * One place that answers "which absolute file/directory does this operation really touch",
 * so the write guard, the shell guard and the pre-execute hook cannot disagree.
 *
 * Two things are resolved here:
 *  - paths: a relative path is a *session* relative path. It must be resolved against the
 *    originating session's working directory, never against the host process cwd (which,
 *    for a packaged app, is the app bundle). Symlinks are merged through realpath so a link
 *    into a live plugin is still seen as the live plugin.
 *  - plugin_manager targets: `include:<patchRowId>`, a bundle package name, a bare package
 *    name or a link spec all map to the directory that will actually be loaded.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ANCESTOR_HOPS = 8;

/** realpath of the deepest existing ancestor, with the still-missing tail appended. */
export function canonicalPath(file) {
  const abs = path.resolve(String(file ?? '.'));
  let head = abs;
  const tail = [];
  for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
  return abs;
}

/** Inside a tree, after symlinks are merged. A sibling with the same prefix is not inside. */
export function isInside(root, file) {
  if (!root || !file) return false;
  const base = canonicalPath(root);
  const target = canonicalPath(file);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/** Path for display: absolute, symlinks merged, without the platform's trailing separator. */
export function displayPath(file) {
  return canonicalPath(file);
}

/**
 * The session working directory, from the host mechanism the tool layer itself uses:
 * the `workingDirectory` service reads a synchronous, IO-free projection. The fallbacks
 * cover older hosts and tests; when none answers, the result is `cwd: null` and callers
 * must say "cannot be resolved" instead of guessing with process.cwd().
 */
export function sessionCwd(agent) {
  try {
    const service = agent?.ctx?.get?.('workingDirectory');
    if (service && typeof service.get === 'function') {
      const value = service.get(agent.session);
      if (typeof value === 'string' && value) return { cwd: value, source: 'workingDirectory' };
    }
  } catch {
    /* service missing on this host: try the plain fields below */
  }
  for (const key of ['cwd', 'workingDirectory', 'directory']) {
    const value = agent?.[key];
    if (typeof value === 'string' && value) return { cwd: value, source: key };
  }
  try {
    const value = agent?.session?.header?.cwd;
    if (typeof value === 'string' && value) return { cwd: value, source: 'session.header.cwd' };
  } catch {
    /* no session header */
  }
  return { cwd: null, source: null };
}

/**
 * Resolve a file target.
 * @returns {{file: string, raw: string, source: string, cwd: string|null}}
 *   or `{file: null, raw, reason: 'no-cwd'}` when a relative target cannot be attributed.
 */
export function resolveFileTarget(raw, options = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { file: null, raw: String(raw ?? ''), reason: 'empty' };
  if (path.isAbsolute(value)) return { file: canonicalPath(value), raw: value, source: 'absolute', cwd: null };
  const explicit = typeof options.cwd === 'string' && options.cwd ? options.cwd : null;
  const probe = explicit ? { cwd: explicit, source: 'options.cwd' } : sessionCwd(options.agent);
  if (!probe.cwd) return { file: null, raw: value, reason: 'no-cwd' };
  return { file: canonicalPath(path.resolve(probe.cwd, value)), raw: value, source: probe.source, cwd: probe.cwd };
}

/** Parse the `id:` / `name:` / `disabled:` rows of a Cordis patch file. */
export function patchRows(text) {
  const rows = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const id = /^\s*(?:-\s+)?id:\s*["']?([A-Za-z0-9_.:@/-]+)/.exec(line);
    if (id) {
      current = { id: id[1], name: null, disabled: false };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    const name = /^\s*(?:-\s+)?name:\s*["']?([@A-Za-z0-9_.:/-]+)/.exec(line);
    if (name && !current.name) {
      current.name = name[1];
      continue;
    }
    if (/^\s*disabled:\s*true\b/.test(line)) current.disabled = true;
  }
  return rows;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statKey(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function bundleNames(pkg) {
  const list = pkg?.dsh?.profile?.bundles;
  return new Set(Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);
}

/**
 * The entry index the plugin manager uses: every live `entryId` (`include:<patchRowId>` for
 * bundle rows) mapped to the module directory that will actually load.
 * @returns {Map<string, {id: string, name: string, dir: string, bundle: string|null, enabled: boolean}>}
 */
export function entryIndex(surfaces) {
  if (!surfaces || typeof surfaces !== 'object') return new Map();
  const pkgFile = surfaces.pkgFile || path.join(surfaces.profileDir || '.', 'package.json');
  const patchFile = surfaces.patchFile || path.join(surfaces.profileDir || '.', 'cordis.patch.yml');
  const stamp = `${statKey(pkgFile)}|${statKey(patchFile)}|${(surfaces.plugins || []).length}`;
  if (surfaces._entries && surfaces._entries.stamp === stamp) return surfaces._entries.map;

  const pkg = readJson(pkgFile) || {};
  const enabledBundles = bundleNames(pkg);
  const depDirs = new Map((surfaces.plugins || []).map((plugin) => [plugin.name, plugin.dir]));
  const overrides = new Map();
  const namedRows = new Map();
  for (const row of patchRows(readText(patchFile) || '')) {
    if (row.name || row.disabled) overrides.set(row.id, row);
    if (row.name && !namedRows.has(row.name)) namedRows.set(row.name, row);
  }

  const index = new Map();
  const put = (entryId, name, dir, bundle) => {
    const override = overrides.get(entryId.replace(/^include:/, ''));
    const enabled = bundle ? enabledBundles.has(bundle) && !override?.disabled : !override?.disabled;
    index.set(entryId, { id: entryId, name, dir, bundle: bundle || null, enabled });
  };

  /* rows a bundle contributes: `id:` inside its own patch becomes live entry `include:<id>` */
  for (const plugin of surfaces.plugins || []) {
    const ownPkg = readJson(path.join(plugin.dir, 'package.json')) || {};
    const patchRel = ownPkg?.dsh?.bundle?.patch;
    const rows = typeof patchRel === 'string' ? patchRows(readText(path.join(plugin.dir, patchRel)) || '') : [];
    /* The plugin's own module directory is always a live surface: it loads as a dependency even when
     * none of the rows its bundle patch contributes are mounted. `enabled` follows only the explicit
     * `disabled:` flag on the profile row that names it. */
    const ownName = typeof ownPkg.name === 'string' && ownPkg.name ? ownPkg.name : plugin.name;
    const named = namedRows.get(ownName) || namedRows.get(plugin.name);
    const ownId = named ? named.id : ownName;
    if (!index.has(ownId) && !index.has(`include:${ownId}`)) {
      index.set(ownId, { id: ownId, name: ownName, dir: plugin.dir, bundle: null, enabled: !named?.disabled });
    }
    if (!rows.length) continue;
    for (const row of rows) {
      const moduleName = row.name || ownPkg.name || plugin.name;
      const dir = typeof moduleName === 'string' && depDirs.has(moduleName) ? depDirs.get(moduleName) : plugin.dir;
      put(`include:${row.id}`, moduleName, dir, ownPkg.name || plugin.name);
    }
  }

  /* rows authored directly in the profile patch (enable/disable overrides, plain inserts) */
  for (const row of patchRows(readText(patchFile) || '')) {
    if (index.has(row.id) || index.has(`include:${row.id}`)) continue;
    if (!row.name) continue;
    const dir = depDirs.get(row.name);
    if (!dir) continue;
    put(row.id, row.name, dir, null);
  }

  surfaces._entries = { stamp, map: index };
  return index;
}

/** Plugin dirs the loader currently activates, one per live entry (deduplicated). */
export function liveEntryDirs(surfaces) {
  const dirs = new Map();
  for (const entry of entryIndex(surfaces).values()) {
    if (!entry.enabled) continue;
    if (!dirs.has(entry.dir)) dirs.set(entry.dir, entry);
  }
  return [...dirs.values()];
}

/**
 * Resolve a plugin_manager target to the directory the loader would read.
 * Accepts `include:<rowId>`, a bare `<package name>`, a bundle package name, a `link:`/`file:`
 * spec, or an absolute/relative path. `bundles` is filled with bundle dirs the target still
 * depends on, so a caller can decide whether it inspected everything.
 */
export function resolvePluginTarget(args, surfaces) {
  const target = typeof args?.target === 'string' ? args.target.trim() : '';
  if (!target) return { dir: null, reason: 'no-target', entries: [], unresolved: true };
  const map = entryIndex(surfaces);
  const profileDir = surfaces?.profileDir || process.cwd();

  if (map.has(target)) {
    const entry = map.get(target);
    return { dir: entry.dir, reason: 'entry-id', entries: [entry], bundle: entry.bundle, unresolved: false };
  }

  if (target.startsWith('link:') || target.startsWith('file:')) {
    const raw = target.slice(target.indexOf(':') + 1);
    const dir = canonicalPath(path.resolve(profileDir, raw));
    return { dir: fs.existsSync(dir) ? dir : null, reason: dir && fs.existsSync(dir) ? 'spec' : 'missing', entries: [], unresolved: !fs.existsSync(dir) };
  }

  if (path.isAbsolute(target)) {
    const dir = canonicalPath(target);
    return { dir: fs.existsSync(dir) ? dir : null, reason: 'absolute', entries: [], unresolved: !fs.existsSync(dir) };
  }

  const name = target.includes(':') && !path.isAbsolute(target) ? target.slice(target.indexOf(':') + 1) : target;

  for (const entry of map.values()) {
    if (entry.name === name) {
      const siblings = [...map.values()].filter((item) => item.dir === entry.dir);
      return { dir: entry.dir, reason: 'name', entries: siblings, bundle: entry.bundle, unresolved: false };
    }
  }

  const plugins = surfaces?.plugins || [];
  const plugin = plugins.find((item) => item.name === name || item.name.endsWith(`/${name}`) || path.basename(item.dir) === name);
  if (plugin) {
    const entries = [...map.values()].filter((entry) => entry.dir === plugin.dir);
    return { dir: plugin.dir, reason: 'plugin-name', entries, bundle: entries[0]?.bundle ?? null, unresolved: false };
  }

  const local = path.join(profileDir, 'node_modules', name);
  if (fs.existsSync(local)) return { dir: canonicalPath(local), reason: 'installed', entries: [], unresolved: false };
  return { dir: null, reason: 'unknown-target', entries: [], unresolved: true };
}

/** What a bundle package name contributes, whether or not it is enabled right now. */
export function resolveBundleTarget(name, surfaces) {
  const target = typeof name === 'string' ? name.trim() : '';
  if (!target) return { dir: null, name: target, entries: [], unresolved: true };
  const map = entryIndex(surfaces);
  const entries = [...map.values()].filter((entry) => entry.bundle === target || entry.name === target);
  if (entries.length) return { dir: entries[0].dir, name: target, entries, unresolved: false };
  const resolved = resolvePluginTarget({ target }, surfaces);
  return { dir: resolved.dir, name: target, entries: resolved.entries, unresolved: resolved.unresolved };
}
