#!/usr/bin/env node
/**
 * Release-manifest gate: fail before publish if `npm pack` would ship an incomplete package.
 *
 * 0.5.0 shipped a tarball without handoff.mjs; every install died with ERR_MODULE_NOT_FOUND.
 * This check reads the packed file list (not package.json `files`, which can drift from what npm
 * actually includes) and fails with a non-zero exit code naming the missing entries.
 *
 * Run: node test/integration/pack-check.mjs
 * Pure Node, no dependencies, no network: `npm pack --dry-run` only walks the work tree.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const PACK_TIMEOUT_MS = 120000;

/** Runtime files a published package must contain. Missing one breaks user installs. */
const REQUIRED = [
  'handoff.mjs',
  'index.js',
  'client.js',
  'core.mjs',
  'cordis.patch.yml',
];

function fail(message) {
  console.error(`FAIL pack-check: ${message}`);
  process.exit(1);
}

/* Windows 上 npm 是 npm.cmd，不带 shell 直接 spawn 会 ENOENT；只在那边走 shell。 */
const WIN = process.platform === 'win32';
const pack = spawnSync(WIN ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
  cwd: PLUGIN_ROOT,
  encoding: 'utf8',
  shell: WIN,
  timeout: PACK_TIMEOUT_MS,
  // Keep npm from rewriting user/global config into the result.
  env: { ...process.env, npm_config_update_notifier: 'false' },
});

if (pack.error) fail(`could not run npm pack: ${pack.error.message}`);
if (pack.status !== 0) {
  fail(`npm pack --dry-run exited ${pack.status}\n${String(pack.stderr || pack.stdout).slice(0, 2000)}`);
}

// npm may print notices on stdout ahead of the JSON payload; take the JSON array span.
const raw = String(pack.stdout || '');
const start = raw.indexOf('[');
const end = raw.lastIndexOf(']');
if (start === -1 || end <= start) fail(`no JSON array in npm pack output: ${raw.slice(0, 800)}`);

let payload;
try {
  payload = JSON.parse(raw.slice(start, end + 1));
} catch (error) {
  fail(`could not parse npm pack --json output: ${error.message}\n${raw.slice(0, 800)}`);
}
if (!Array.isArray(payload) || payload.length === 0) fail(`npm pack --json returned no package entry: ${raw.slice(0, 400)}`);

const pkg = payload[0];
const files = Array.isArray(pkg.files) ? pkg.files : [];
if (files.length === 0) fail('npm pack reported an empty file list');

const shipped = new Set(
  files
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/^\.\//, '').replace(/^package\//, '')),
);

console.log(`pack-check: ${pkg.name}@${pkg.version} ships ${shipped.size} files (${pkg.filename})`);

const missing = REQUIRED.filter((name) => !shipped.has(name));
if (missing.length > 0) {
  console.error(`missing from tarball (${missing.length}): ${missing.join(', ')}`);
  console.error('fix: add each file (or its directory glob) to package.json "files", then re-run.');
  fail('package would be published incomplete');
}

for (const name of REQUIRED) {
  console.log(`- PASS  ${name} is in the tarball`);
}
console.log(`\nsummary: ${REQUIRED.length} pass, 0 fail`);
process.exit(0);
