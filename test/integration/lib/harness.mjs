/**
 * Acceptance harness for dsh-crash-lore defense.
 *
 * Everything here runs in /tmp fixtures: a fake profile that links a fake plugin dir,
 * a fake session cwd, and a fake DSH_HOME. The real profile is only *read* to confirm
 * live surfaces, never written.
 *
 * The harness boots the plugin's real `apply(ctx, config)` against a minimal tools
 * service, so the guard/pre-execute handlers under test are the registered ones —
 * not re-implemented copies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..');
export const INDEX_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'index.js')).href;

export function mkroot(prefix = 'cl-accept-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const DANGEROUS = [
  "import fs from 'node:fs';",
  "fs.writeFileSync('/tmp/cl-acceptance-should-not-run.marker', 'executed');",
  "throw new Error('acceptance probe: top-level throw');",
  '',
].join('\n');

export const SAFE = 'export function apply() {}\n';

/**
 * Build a fake profile that links `pluginDir` under `depName`, plus (optionally) the
 * node_modules symlink a real install would leave behind.
 */
export function makeProfile({ root, pluginDir, depName = 'dev-plugin', patchId = depName, withNodeModulesLink = false }) {
  const profile = path.join(root, 'profiles', 'desktop');
  if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
    write(path.join(pluginDir, 'package.json'), JSON.stringify({ name: depName, version: '0.0.0', type: 'module', main: 'index.js' }));
  }
  if (!fs.existsSync(path.join(pluginDir, 'index.js'))) write(path.join(pluginDir, 'index.js'), SAFE);
  write(path.join(profile, 'package.json'), JSON.stringify({
    name: 'acceptance-profile',
    private: true,
    dependencies: { [depName]: `link:${pluginDir}` },
  }, null, 2));
  write(path.join(profile, 'cordis.patch.yml'), `- insert:\n    - id: ${patchId}\n      name: ${depName}\n      config: {}\n`);
  if (withNodeModulesLink) {
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
    fs.symlinkSync(pluginDir, path.join(profile, 'node_modules', depName));
  }
  return profile;
}

/** Boot the plugin's real apply() against a stub tools service. */
export async function boot({ home, profileDir, config = {} }) {
  process.env.DSH_PROFILE_DIR = profileDir;
  const { apply } = await import(INDEX_URL);
  const registered = new Map();
  const guards = [];
  const handlers = {};
  const disposers = [];
  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on(name, fn) {
      handlers[name] = fn;
      return () => {};
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => {};
      },
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    },
  };
  apply(ctx, { home, ...config });
  // Boot scan is a fire-and-forget promise; give it a beat so guard mode is stable.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    registered,
    guards,
    handlers,
    guardTool: registered.get('crash_lore_guard'),
    callGuard: (exec) => (guards[0] ? guards[0](exec) : undefined),
    callPre: (exec, next = async () => ({ kind: 'next' })) => (handlers['tools/pre-execute'] ? handlers['tools/pre-execute'](exec, next) : next()),
    dispose() {
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
