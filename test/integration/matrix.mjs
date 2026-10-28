#!/usr/bin/env node
/**
 * Acceptance matrix for dsh-crash-lore 0.2.x live defense.
 *
 * Run:   node test/integration/matrix.mjs            (post-fix strict: any FAIL exits 1)
 *        node test/integration/matrix.mjs --baseline (0.2.0 baseline: documented holes are XFAIL)
 *
 * The script only writes under /tmp. It boots the plugin's real apply() from
 * test/integration/lib/harness.mjs, so the handlers are the registered ones.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { mkroot, write, read, makeProfile, boot, DANGEROUS, SAFE, PLUGIN_ROOT } from './lib/harness.mjs';
import { preflight } from '../../guard.mjs';

const BASELINE = process.argv.includes('--baseline');
const KNOWN_020_HOLES = new Set([]); // cleared for strict 0.2.1 verdict

const results = [];
function record(id, ok, expected, actual, extra = {}) {
  const status = ok ? 'PASS' : BASELINE && KNOWN_020_HOLES.has(id) ? 'XFAIL' : 'FAIL';
  results.push({ id, status, expected, actual, ...extra });
  const line = `- ${status.padEnd(5)} ${id} · expected: ${expected} · actual: ${actual}`;
  console.log(line);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && k !== 'ms') console.log(`    ${k}: ${v}`);
}

function isDenied(value) {
  return typeof value === 'string' && value.includes('CRASH_LORE_BLOCKED');
}

function isPreDenied(value) {
  return Boolean(value && value.kind === 'deny' && value.info?.code === 'CRASH_LORE_BLOCKED');
}

async function baseFixture({ prefix = 'cl-accept-', withNodeModulesLink = false, depName = 'dev-plugin' } = {}) {
  const root = mkroot(prefix);
  const workspace = path.join(root, 'workspace');
  const pluginDir = path.join(workspace, depName);
  const profile = makeProfile({ root, pluginDir, depName, withNodeModulesLink });
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const sessionCwd = workspace;
  return { root, workspace, pluginDir, profile, home, sessionCwd };
}

/* ------------------------------------------------------------------ items 1 + 2 */

async function item12() {
  const fx = await baseFixture({ withNodeModulesLink: true });
  const target = path.join(fx.pluginDir, 'probe.mjs');
  write(target, SAFE);
  const before = fs.readFileSync(target);
  const h = await boot({ home: fx.home, profileDir: fx.profile });

  // 1) absolute path to a live plugin source file: deny + file untouched + corrected write allowed.
  const denied = h.callGuard({ name: 'write', arguments: { file_path: target, content: DANGEROUS } });
  record('c1-absolute-deny', isDenied(denied), 'deny with remediation', isDenied(denied) ? 'denied' : 'allowed');
  assert.ok(isDenied(denied), 'absolute live write must be denied');
  record('c1-remediation-text', /改好后重新提交这次写入/.test(denied), 'remediation text present', /改好后重新提交这次写入/.test(denied) ? 'present' : 'missing');
  record('c1-file-unchanged', Buffer.compare(before, fs.readFileSync(target)) === 0, 'target sha256 unchanged', Buffer.compare(before, fs.readFileSync(target)) === 0 ? 'unchanged' : 'CHANGED');
  const fixed = h.callGuard({ name: 'write', arguments: { file_path: target, content: 'export function apply() { /* fixed */ }\n' } });
  record('c1-corrected-write-allowed', fixed === undefined, 'allow after correction', fixed === undefined ? 'allowed' : 'still denied');
  record('c1-side-effect-absent', !fs.existsSync('/tmp/cl-acceptance-should-not-run.marker'), 'module body not executed', fs.existsSync('/tmp/cl-acceptance-should-not-run.marker') ? 'marker EXISTS' : 'absent');

  // 2a) relative path, resolved by the *session* cwd, while the host process cwd is the profile.
  const hostCwd = process.cwd();
  const sessionRel = path.join('workspace', 'dev-plugin', 'probe.mjs');
  const sessionResolved = path.resolve(fx.root, sessionRel);
  const hostResolved = path.resolve(fx.profile, sessionRel);
  process.chdir(fx.profile);
  try {
    const relDenied = h.callGuard({ name: 'write', arguments: { file_path: sessionRel, content: DANGEROUS } });
    record('c2-relative-path', isDenied(relDenied), `deny for ${sessionResolved} (same file as absolute)`, isDenied(relDenied) ? 'denied' : `ALLOWED (content would land in ${sessionResolved}; guard checked ${hostResolved})`);
  } finally {
    process.chdir(hostCwd);
  }

  // 2b) same file through the node_modules symlink left by a link: install.
  const viaLink = path.join(fx.profile, 'node_modules', 'dev-plugin', 'probe.mjs');
  const realOfLinkDir = fs.realpathSync(path.dirname(viaLink));
  record('c3-same-file-check', realOfLinkDir === fs.realpathSync(fx.pluginDir), 'symlink path resolves to plugin dir', `${realOfLinkDir}`);
  const symDenied = h.callGuard({ name: 'write', arguments: { file_path: viaLink, content: DANGEROUS } });
  record('c3-symlink-dir', isDenied(symDenied), 'deny via symlinked path to same file', isDenied(symDenied) ? 'denied' : `ALLOWED (realpath ${realOfLinkDir} is live)`);

  h.dispose();
  return fx;
}

/* --------------------------------------------------------------- item 3 installs */

async function badPlugin(root, name = 'bad-plugin', { patchId = name } = {}) {
  const dir = path.join(root, name);
  write(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(path.join(dir, 'index.js'), DANGEROUS);
  write(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${patchId}\n      name: ${name}\n      config: {}\n`);
  return dir;
}

async function item3() {
  // 3a) install_bundle of a locally broken plugin, package name == patch id.
  {
    const root = mkroot('cl-accept-install-');
    const bad = await badPlugin(root, 'bad-plugin');
    const pluginDir = path.join(root, 'workspace', 'dev-plugin');
    const profile = makeProfile({ root, pluginDir, depName: 'dev-plugin' });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bad}` } });
    record('c4-install-bundle', isPreDenied(r), 'deny broken local plugin install', isPreDenied(r) ? `denied ${r.info.rule}` : 'ALLOWED');
    h.dispose();
  }

  // 3b) set_plugin by entry id, ids aligned.
  {
    const root = mkroot('cl-accept-set-');
    const bad = await badPlugin(root, 'bad-plugin');
    const profile = path.join(root, 'profile');
    write(path.join(profile, 'package.json'), JSON.stringify({ name: 'acceptance-profile', private: true, dependencies: { 'bad-plugin': `link:${bad}` } }, null, 2));
    write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: bad-plugin\n      name: bad-plugin\n      config: {}\n');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'include:bad-plugin', enabled: true } });
    record('c5-set-entry-aligned', isPreDenied(r), 'deny enabling broken installed plugin', isPreDenied(r) ? `denied ${r.info.rule}` : 'ALLOWED');
    h.dispose();
  }

  // 3c) set_plugin by entry id where the patch id differs from the package name
  //     (real shape: entryId include:crash-lore, package dsh-crash-lore).
  {
    const root = mkroot('cl-accept-mismatch-');
    const bad = await badPlugin(root, 'dsh-bad-plugin', { patchId: 'bad' });
    const profile = makeProfile({ root, pluginDir: bad, depName: 'dsh-bad-plugin', patchId: 'bad' });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'include:bad', enabled: true } });
    record('c6set-entry-id-mismatch', isPreDenied(r), 'deny when entry id != package name', isPreDenied(r) ? `denied ${r.info.rule}` : 'ALLOWED (candidateDir could not map include:bad to dsh-bad-plugin)');
    h.dispose();
  }

  // 3d) set_bundle enable path is never inspected.
  {
    const root = mkroot('cl-accept-bundle-');
    const bad = await badPlugin(root, 'bad-bundle-plugin');
    const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin'), depName: 'dev-plugin' });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'bad-bundle', enabled: true } });
    record('c7-set-bundle', isPreDenied(r), 'inspect bundle before enabling', isPreDenied(r) ? `denied ${r.info.rule}` : 'ALLOWED (preExecute has no set_bundle branch)');
    h.dispose();
    record('c7-unresolved-fails-closed', isPreDenied(r) && r.info?.rule === 'uninspected', 'unresolvable bundle target is denied (fail closed), not skipped', isPreDenied(r) ? `denied ${r.info?.rule}` : 'ALLOWED');
  }

  // 3e) a plugin installed *after* the defense started: absolute path is still inspected.
  {
    const root = mkroot('cl-accept-new-');
    const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin'), depName: 'dev-plugin' });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const fresh = await badPlugin(root, 'freshly-installed');
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${fresh}` } });
    record('c8-new-after-start', isPreDenied(r), 'new candidate outside index still preflighted', isPreDenied(r) ? `denied ${r.info.rule}` : 'ALLOWED (not in index and no absolute fallback)');
    h.dispose();
  }
}

/* ------------------------------------------------------------------- item 6 modes */

async function item6() {
  const root = mkroot('cl-accept-modes-');
  const bad = await badPlugin(root, 'bad-plugin');
  const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin'), depName: 'dev-plugin' });
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });

  // guard on
  {
    const h = await boot({ home, profileDir: profile, config: { guard: true } });
    const status = await h.guardTool.execute({ limit: 5 });
    record('c9-mode-guard', status.mode === 'protect' && status.modeLabel === '开启' && status.hooks.write === 'sync' && status.hooks.preExecute === 'async', 'protect + 开启 label + both hooks', `${status.mode}/${status.modeLabel} write=${status.hooks.write} pre=${status.hooks.preExecute}`);
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bad}` } });
    record('c9-guard-denies', isPreDenied(r), 'deny in guard mode', isPreDenied(r) ? 'denied' : 'ALLOWED');
    h.dispose();
  }

  // monitor only
  {
    const h = await boot({ home, profileDir: profile, config: { monitorOnly: true } });
    const status = await h.guardTool.execute({ limit: 5 });
    record('c10-mode-monitor-text', status.mode === 'observe' && status.modeLabel === '仅监测' && status.hooks.write === 'sync' && status.hooks.preExecute === 'async', 'observe + 仅监测 label + both hooks', `${status.mode}/${status.modeLabel} write=${status.hooks.write} pre=${status.hooks.preExecute}`);
    let nextCalled = false;
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bad}` } }, async () => { nextCalled = true; return { kind: 'next' }; });
    record('c10-monitor-allows', r?.kind === 'next' && nextCalled, 'allow but record', r?.kind === 'next' ? `allowed, denials=${status.denials.length + 1}` : 'DENIED');
    const after = await h.guardTool.execute({ limit: 5 });
    record('c10-monitor-records', after.denials.length >= 1, 'denial recorded while monitoring', `${after.denials.length} recorded`);
    h.dispose();
  }

  // off
  {
    const h = await boot({ home, profileDir: profile, config: { guard: false } });
    const status = await h.guardTool.execute({ limit: 5 });
    record('c11-mode-off', status.mode === 'off' && status.modeLabel === '关闭' && status.hooks.write === null && status.hooks.preExecute === null && h.guards.length === 0, 'off + 关闭 label + no hooks + no guard', `${status.mode}/${status.modeLabel} write=${status.hooks.write} pre=${status.hooks.preExecute} guards=${h.guards.length}`);
    const offBefore = (await h.guardTool.execute({ limit: 20 })).denials.length;
    const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bad}` } });
    record('c11-off-allows', r?.kind === 'next', 'no denial when off', r?.kind === 'next' ? 'allowed' : 'DENIED');
    const offAfter = (await h.guardTool.execute({ limit: 20 })).denials.length;
    record('c11-off-no-record', offAfter === offBefore, 'no recording when off', `${offAfter - offBefore} new record(s)`);
    h.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/* -------------------------------------------------- item 5 PTC payload + item 4 */

async function item45() {
  // A denial carries the full remediation payload back through the pre-execute
  // decision object; a PTC sub-call surfaces it verbatim as the tool error.
  {
    const root = mkroot('cl-accept-ptc-');
    const bad = await badPlugin(root, 'bad-ptc');
    const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin'), depName: 'dev-plugin' });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const h = await boot({ home, profileDir: profile });
    const decision = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bad}` } });
    const payloadOk = isPreDenied(decision)
      && decision.info.name === 'CrashLoreBlocked'
      && /位置：/.test(decision.reason) && /建议：/.test(decision.reason) && /重新提交/.test(decision.reason);
    record('c13-ptc-payload', payloadOk, 'structured denial with rule/位置/建议/重新提交', payloadOk ? `code=${decision.info.code} rule=${decision.info.rule}` : 'payload incomplete');
    h.dispose();
  }

  // Isolation: a normal dev write outside live surfaces is untuched by the guard, and a
  // denial for one file does not poison the next call.
  {
    const fx = await baseFixture({ prefix: 'cl-accept-iso-' });
    const h = await boot({ home: fx.home, profileDir: fx.profile });
    const normal = path.join(fx.root, 'normal', 'app.mjs');
    record('c12-normal-write', h.callGuard({ name: 'write', arguments: { file_path: normal, content: DANGEROUS } }) === undefined, 'non-live file unaffected', 'allowed');
    const isoBefore = (await h.guardTool.execute({ limit: 20 })).denials.length;
    h.callGuard({ name: 'write', arguments: { file_path: path.join(fx.pluginDir, 'probe.mjs'), content: DANGEROUS } });
    record('c12-next-call-clean', h.callGuard({ name: 'write', arguments: { file_path: normal, content: SAFE } }) === undefined, 'later call unaffected by prior denial', 'allowed');
    const isoAfter = (await h.guardTool.execute({ limit: 20 })).denials.length;
    record('c12-denial-scope', isoAfter === isoBefore + 1, 'only live write recorded', `${isoAfter - isoBefore} new record(s)`);
    h.dispose();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------- item 7 performance */

async function item7() {
  const root = mkroot('cl-accept-perf-');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'perf-20-entries', version: '1.0.0', type: 'module', main: 'index.js' }));
  write(path.join(root, 'cordis.patch.yml'), '- insert:\n    - id: perf\n      name: perf-20-entries\n      config: {}\n');
  write(path.join(root, 'index.js'), 'export function apply() {}\n');
  for (let i = 1; i <= 20; i += 1) {
    const dir = path.join(root, `feature-${String(i).padStart(2, '0')}`);
    write(path.join(dir, 'index.js'), `import path from 'node:path';\nexport function apply(ctx) {\n  ctx.effect(() => () => {});\n  return path.basename(import.meta.url);\n}\n`);
  }
  const samples = [];
  let first = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const findings = preflight(root);
    samples.push(performance.now() - t0);
    if (i === 0) first = findings;
  }
  record('c14-perf-findings', first.length === 0, 'no false positives on 20 entry files', first.length ? first.map((f) => `${f.ruleId}@${f.file}`).join(', ') : 'none');
  const ms = Math.min(...samples);
  record('c14-perf-200ms', ms < 200, 'preflight(20 entries) < 200 ms', `${ms.toFixed(1)} ms (samples ${samples.map((n) => n.toFixed(1)).join(', ')})`, { ms: Number(ms.toFixed(1)) });
  // Attribute the cost: the 20 entry files are syntax-checked one node --check child per file.
  const perFile = [];
  for (let i = 1; i <= 20; i += 1) {
    const file = path.join(root, `feature-${String(i).padStart(2, '0')}`, 'index.js');
    const t0 = performance.now();
    spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    perFile.push(performance.now() - t0);
  }
  const spawnTotal = perFile.reduce((a, b) => a + b, 0);
  record('c14-perf-attribution', true, 'cost source: node --check per entry', `${spawnTotal.toFixed(0)} ms in 20 child node --check calls (${(spawnTotal / 20).toFixed(1)} ms/file) vs ${ms.toFixed(0)} ms total`);
  fs.rmSync(root, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------- run all */

await item12();
await item3();
await item6();
await item45();
await item7();

const failed = results.filter((r) => r.status === 'FAIL');
const xfail = results.filter((r) => r.status === 'XFAIL');
console.log(`\nsummary: ${results.filter((r) => r.status === 'PASS').length} pass, ${failed.length} fail, ${xfail.length} xfail (baseline=${BASELINE})`);
const out = path.join('/tmp', 'cl-acceptance-matrix.json');
fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), baseline: BASELINE, results }, null, 2)}\n`);
console.log(`results: ${out}`);
process.exit(failed.length ? 1 : 0);
