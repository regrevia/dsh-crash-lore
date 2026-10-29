#!/usr/bin/env node
/**
 * One-command acceptance run for dsh-lifeguard.
 *
 *   node scripts/verify-0.2.1.mjs            # strict: every known hole is a failure
 *   node scripts/verify-0.2.1.mjs --baseline # record current failures (0.2.0 baseline)
 *
 * Steps:
 *   1. npm test                      (plugin self-test suite)
 *   2. node cli.mjs check .          (author preflight CLI)
 *   3. test/integration/matrix.mjs   (real tool-call matrix, 8 acceptance items)
 *   4. test/integration/cold-install.mjs (npm pack -> throw-away profile install -> boot)
 *   5. live wiring read-only check   (real profile points at this checkout)
 *
 * Never writes product code, the real profile, or ~/.dsh. All fixtures live under the OS temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, HERE } from '../test/integration/lib/harness.mjs';

const baseline = process.argv.includes('--baseline');
const results = [];
const started = new Date();

function section(name, ok, detail, ms, output) {
  results.push({ name, ok, detail, ms: Math.round(ms) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail} (${(ms / 1000).toFixed(1)}s)`);
  if (!ok && output) {
    const tail = output.trimEnd().split('\n').slice(-40).join('\n');
    console.log(tail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

function step(name, cmd, args, opts = {}) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 240000, ...opts });
  const ms = performance.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  const detail = ok
    ? (out.trim().split('\n').filter((l) => /pass|通过|summary|规则|rules/i.test(l)).slice(-1)[0] || 'ok').slice(0, 140)
    : `exit ${r.status ?? r.signal}`;
  section(name, ok, detail, ms, out);
  return { ok, out };
}

console.log(`dsh-lifeguard acceptance · ${started.toISOString()} · node ${process.version}${baseline ? ' · baseline mode' : ''}`);
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
console.log(`checkout: ${PLUGIN_ROOT} (v${pkg.version})`);
console.log('');

step('self-test', process.execPath, ['--test', 'test/*.test.mjs']);
step('cli-preflight', process.execPath, ['cli.mjs', 'check', '.']);
step('matrix', process.execPath, ['test/integration/matrix.mjs', ...(baseline ? ['--baseline'] : [])]);
step('release-package', process.execPath, ['test/integration/cold-install.mjs']);
step('extras-evidence', process.execPath, ['test/integration/extras.mjs']);

/* Read-only proof that the running desktop profile still points at this checkout. */
{
  const t0 = performance.now();
  const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
  const facts = [];
  let ok = true;
  try {
    const profilePkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const spec = profilePkg.dependencies?.['dsh-lifeguard'];
    facts.push(`dep=${spec ?? 'MISSING'}`);
    ok = ok && typeof spec === 'string' && spec.startsWith('link:') && fs.realpathSync(spec.slice('link:'.length)) === fs.realpathSync(PLUGIN_ROOT);
    const nm = path.join(profileDir, 'node_modules', 'dsh-lifeguard');
    const linked = fs.realpathSync(nm);
    facts.push(`node_modules->${linked}`);
    ok = ok && linked === fs.realpathSync(PLUGIN_ROOT);
    // The plugin ships its own bundle patch (dsh.bundle.patch); the profile need not repeat it.
    const bundle = path.join(PLUGIN_ROOT, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml');
    const patch = fs.readFileSync(bundle, 'utf8');
    const hasPatch = /^\s*-\s*id:\s*lifeguard\s*$/m.test(patch) && /name:\s*dsh-lifeguard/.test(patch);
    facts.push(`bundle-patch=${hasPatch ? path.relative(PLUGIN_ROOT, bundle) : 'MISSING'}`);
    ok = ok && hasPatch;
  } catch (error) {
    ok = false;
    facts.push(`error: ${error.message}`);
  }
  section('live-wiring(readonly)', ok, facts.join(' · '), performance.now() - t0);
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`summary: ${results.length - failed.length} pass, ${failed.length} fail${baseline && failed.length ? ' (baseline: failures expected until fixes land)' : ''}`);
const outFile = path.join('/tmp', 'cl-acceptance-verify.json');
fs.writeFileSync(outFile, `${JSON.stringify({ at: started.toISOString(), version: pkg.version, baseline, results }, null, 2)}\n`);
console.log(`results: ${outFile}`);
console.log(`matrix evidence: /tmp/cl-acceptance-matrix.json · cold install: /tmp/cl-acceptance-cold-install.json`);
process.exitCode = failed.length ? 1 : 0;
