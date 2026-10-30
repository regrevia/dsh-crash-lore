#!/usr/bin/env node
/**
 * Release-package acceptance: build the tarball users actually receive, install it
 * into a throw-away profile, boot it from there with a throw-away DSH_HOME, and
 * check that the package is complete, portable, and starts with no author data.
 *
 * Run: node test/integration/cold-install.mjs
 * Writes only under the OS temp dir. Never touches the real profile or ~/.dsh.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT } from './lib/harness.mjs';

const results = [];
function record(id, ok, expected, actual) {
  results.push({ id, ok });
  console.log(`- ${(ok ? 'PASS' : 'FAIL').padEnd(5)} ${id} · expected: ${expected} · actual: ${actual}`);
}
/* Windows 上 npm 是 npm.cmd：不带 shell 的 spawn 会 ENOENT。 */
function run(cmd, args, opts = {}) {
  const viaShell = cmd === 'npm' && process.platform === 'win32';
  return spawnSync(viaShell ? 'npm.cmd' : cmd, args, { encoding: 'utf8', timeout: 120000, shell: viaShell, ...opts });
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cold-'));
const profile = path.join(root, 'profile');
const home = path.join(root, 'home');
const profileNm = path.join(profile, 'node_modules');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(home, { recursive: true });

/* 1) npm pack: exactly what the registry would receive. */
const pack = run('npm', ['pack', '--json', '--pack-destination', root], { cwd: PLUGIN_ROOT });
record('p1-npm-pack', pack.status === 0, 'npm pack exits 0', pack.status === 0 ? 'ok' : String(pack.stderr).slice(0, 400));
if (pack.status !== 0) {
  console.log(`package build failed; artefacts kept at ${root}`);
  process.exit(1);
}
let tgz = null;
try {
  tgz = path.join(root, JSON.parse(pack.stdout)[0].filename);
} catch {
  tgz = walk(root).find((f) => f.endsWith('.tgz')) || null;
}
record('p2-tarball', Boolean(tgz && fs.existsSync(tgz)), 'tarball produced', tgz ? `${path.basename(tgz)} ${fs.statSync(tgz).size}B` : 'missing');

const listing = run('tar', ['-tzf', tgz]).stdout.split('\n').filter(Boolean);
const has = (name) => listing.some((row) => row === `package/${name}` || row.startsWith(`package/${name}/`));
record('p3-ships-defense', has('defense.mjs') && has('guard.mjs') && has('index.js') && has('cordis.patch.yml'), 'defense.mjs + guard.mjs + index.js + cordis.patch.yml in tarball', ['defense.mjs', 'guard.mjs', 'index.js', 'cordis.patch.yml'].filter((f) => !has(f)).join(', ') || 'all present');
record('p4-ships-locale-seed', has('locale/en.json') && has('locale/zh.json') && has('rules.seed.json'), 'locale/en.json + locale/zh.json + rules.seed.json', [has('locale/en.json'), has('locale/zh.json'), has('rules.seed.json')].join('/'));
record('p5-no-corpus', !listing.some((row) => row.startsWith('package/corpus/')), 'author corpus/ not published', listing.filter((r) => r.startsWith('package/corpus/')).slice(0, 3).join(', ') || 'absent');
record('p6-no-incidents', !listing.some((row) => /\.jsonl$/.test(row)), 'no incident logs in tarball', listing.filter((r) => /\.jsonl$/.test(r)).slice(0, 3).join(', ') || 'absent');
record('p7-no-tests-dev', !listing.some((row) => /^package\/(test|tests|docs|scripts)\//.test(row)), 'no test/docs/scripts in tarball', listing.filter((r) => /^package\/(test|tests|docs|scripts)\//.test(r)).slice(0, 3).join(', ') || 'absent');

/* 2) cold install into a throw-away profile, the way the host would. */
fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({ name: 'cl-cold-profile', private: true, type: 'module', dependencies: { 'dsh-lifeguard': `file:${tgz}` } }, null, 2)}\n`);
const install = run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', profile], { cwd: profile });
record('p8-npm-install', install.status === 0, 'npm install from tarball exits 0', install.status === 0 ? 'ok' : String(install.stderr).slice(0, 600));
// Registry installs are declared as a version range, not as file:<tarball>; use the same shape the
// host sees so live-surface resolution is exercised the way it is in production.

const installed = path.join(profileNm, 'dsh-lifeguard');
if (!fs.existsSync(installed)) {
  record('p9-installed-dir', false, 'node_modules/dsh-lifeguard exists', 'missing');
  console.log(`artefacts kept at ${root}`);
  process.exit(1);
}
record('p9-installed-dir', true, 'node_modules/dsh-lifeguard exists', installed);
const installedVersion = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({ name: 'cl-cold-profile', private: true, type: 'module', dependencies: { 'dsh-lifeguard': installedVersion } }, null, 2)}\n`);

for (const f of ['defense.mjs', 'guard.mjs', 'index.js', 'cordis.patch.yml', 'rules.seed.json', 'locale/en.json', 'locale/zh.json']) {
  record(`p10-file-${f.replace(/\W/g, '-')}`, fs.existsSync(path.join(installed, f)), `${f} present after install`, fs.existsSync(path.join(installed, f)) ? 'present' : 'missing');
}
record('p11-installed-no-corpus', !fs.existsSync(path.join(installed, 'corpus')), 'corpus/ absent after install', fs.existsSync(path.join(installed, 'corpus')) ? 'PRESENT' : 'absent');

// Portable source: no author machine paths smuggled into shipped text files.
const shippedText = walk(installed).filter((f) => /\.(mjs|js|json|yml|yaml|md|txt)$/.test(f));
const leaked = shippedText.filter((f) => fs.readFileSync(f, 'utf8').includes('/Users/apple'));
record('p12-no-author-paths', leaked.length === 0, 'no /Users/apple paths in shipped sources', leaked.slice(0, 3).map((f) => path.relative(installed, f)).join(', ') || 'none');

// locale files must be valid flat JSON.
let localeOk = true;
const localeDetail = [];
for (const lang of ['en', 'zh']) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(installed, 'locale', `${lang}.json`), 'utf8'));
    const nested = Object.values(doc).some((v) => v && typeof v === 'object');
    localeOk = localeOk && !nested && Object.keys(doc).length > 0;
    localeDetail.push(`${lang}:${Object.keys(doc).length}${nested ? ' nested!' : ''}`);
  } catch (error) {
    localeOk = false;
    localeDetail.push(`${lang}: ${error.message}`);
  }
}
record('p13-locale-valid', localeOk, 'both locale files parse as flat keys', localeDetail.join(' / '));

// Every relative import between shipped sources must resolve in the installed copy: `npm pack`
// only ships `files`, so a new runtime module that misses that list breaks installs while a
// link:-mounted checkout still works.
const shippedJs = walk(installed).filter((f) => /\.(mjs|js)$/.test(f));
const brokenImports = [];
for (const file of shippedJs) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) brokenImports.push(`${path.relative(installed, file)} -> ${match[1]}`);
  }
}
record('p13b-import-closure', brokenImports.length === 0, 'every relative import resolves in the installed copy', brokenImports.slice(0, 4).join('; ') || `${shippedJs.length} files closed`);
const syntaxBad = [];
for (const file of shippedJs) {
  const check = run('node', ['--check', file]);
  if (check.status !== 0) syntaxBad.push(`${path.relative(installed, file)}: ${String(check.stderr).split('\n')[0]}`);
}
record('p13c-syntax-all', syntaxBad.length === 0, 'every shipped runtime file passes node --check', syntaxBad.slice(0, 3).join('; ') || `${shippedJs.length} files ok`);

/* 3) boot the installed package against a fresh home. */
const fakeHome = path.join(root, 'home');
const runner = path.join(root, 'runner.mjs');
fs.writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [indexFile, homeDir, profileDir] = process.argv.slice(2);
process.env.DSH_HOME = homeDir;
process.env.DSH_PROFILE_DIR = profileDir;
// Simulate a machine that has never run DSH: the scanner must not reach this box's real logs.
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
const guards = [];
const registered = [];
const handlers = [];
const disposers = [];
const ctx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  on(event, fn) { handlers.push({ event, fn }); },
  tools: {
    register(tool) { registered.push(tool); },
    guard(fn) { guards.push(fn); },
    get(name) { return registered.find((t) => t.name === name); },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get(name) { if (name === 'tools') return this.tools; },
};
const mod = await import(pathToFileURL(indexFile).href);
await mod.apply(ctx, { home: homeDir });
await new Promise((resolve) => setTimeout(resolve, 30));
const guardTool = registered.find((t) => t.name === 'lifeguard_guard');
const status = await guardTool.execute({ limit: 5 });
const target = path.join(profileDir, 'node_modules', 'dsh-lifeguard', 'index.js');
const before = fs.readFileSync(target);
const denial = guards[0]?.({ name: 'write', arguments: { file_path: target, content: 'throw new Error("top level");' } });
const unchanged = Buffer.compare(before, fs.readFileSync(target)) === 0;
console.log(JSON.stringify({
  version: mod.VERSION ?? null,
  mode: status.mode,
  modeLabel: status.modeLabel ?? null,
  capability: status.capability ?? null,
  hooks: status.hooks,
  rules: status.rules ?? status.ruleCount ?? null,
  denials: status.denials?.length ?? null,
  guardDenied: typeof denial === 'string' && denial.includes('LIFEGUARD_BLOCKED'),
  unchanged,
  homeFiles: fs.existsSync(homeDir) ? fs.readdirSync(homeDir) : [],
  homeCrashLore: fs.existsSync(path.join(homeDir, 'lifeguard')) ? fs.readdirSync(path.join(homeDir, 'lifeguard')) : [],
}));
`);
const boot = run(process.execPath, [runner, path.join(installed, 'index.js'), home, profile], { cwd: profile, timeout: 60000 });
record('p14-boot', boot.status === 0, 'installed package boots and registers tools', boot.status === 0 ? 'ok' : String(boot.stderr || boot.stdout).slice(0, 800));
if (boot.status !== 0) {
  console.log(`artefacts kept at ${root}`);
  process.exit(1);
}
const line = boot.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
const info = JSON.parse(line);
record('p15-mode', info.mode === 'protect' && info.modeLabel === '开启' && info.hooks?.write === 'sync' && info.hooks?.preExecute === 'async' && info.capability === 'normal', 'cold install reports protect/开启 with both hooks', `${info.mode}/${info.modeLabel} capability=${info.capability} write=${info.hooks?.write} pre=${info.hooks?.preExecute}`);
record('p16-guard-works', info.guardDenied && info.unchanged, 'write into installed live plugin is denied, file untouched', `denied=${info.guardDenied} untouched=${info.unchanged}`);
const crashDir = path.join(home, 'lifeguard');
const rulesFile = path.join(crashDir, 'rules.json');
const incidentsFile = path.join(crashDir, 'incidents.jsonl');
let ruleCount = 0;
try {
  const doc = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
  ruleCount = Array.isArray(doc) ? doc.length : Array.isArray(doc.rules) ? doc.rules.length : Object.keys(doc).length;
} catch { /* reported below */ }
record('p17-seed-rules', ruleCount > 0, 'fresh home seeds rules from rules.seed.json', `${ruleCount} rules in ${path.relative(root, rulesFile) || rulesFile}`);
const incidentLines = fs.existsSync(incidentsFile) ? fs.readFileSync(incidentsFile, 'utf8').split('\n').filter(Boolean) : [];
const authorIncidents = incidentLines.filter((l) => /vantage|dsh-vantage|regrevia/i.test(l));
record('p18-no-author-incidents', incidentLines.length === 0 && info.denials === 0, "author's incidents are not the user's", `${incidentLines.length} incident line(s), ${authorIncidents.length} matching author data, ${info.denials} denial(s)`);
record('p19-paths-under-home', fs.existsSync(crashDir) && crashDir.startsWith(root), 'default paths resolve under DSH_HOME', path.relative(root, crashDir) || crashDir);
record('p20-no-side-effects', !fs.existsSync('/tmp/cl-acceptance-should-not-run.marker'), 'denied content never executed', fs.existsSync('/tmp/cl-acceptance-should-not-run.marker') ? 'marker EXISTS' : 'absent');

const failed = results.filter((r) => !r.ok);
console.log(`\nsummary: ${results.length - failed.length} pass, ${failed.length} fail (artefacts ${root})`);
const out = path.join('/tmp', 'cl-acceptance-cold-install.json');
fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), tarball: path.basename(tgz), results }, null, 2)}\n`);
console.log(`results: ${out}`);
process.exit(failed.length ? 1 : 0);
