#!/usr/bin/env node
/**
 * Adversarial acceptance probes for dsh-crash-lore 0.2.1 (Agent C, independent).
 *
 * These do not replace the matrix; they pin down edge cases the matrix fixtures do not
 * reach. Only /tmp is written. Run:  node test/integration/adversarial.mjs [--strict]
 *
 * History: before the 2026-10-29 fix, install preflight passed a 150 ms budget and a plugin
 * whose entry parse exceeded it was counted "unchecked" and ALLOWED (fail-open). The fix is
 * fail-closed for install/enable only: one bounded retry (3000 ms), then ruleId
 * 'uninspected'. The write guard keeps its fail-open budget (c14 unchanged).
 *
 * a1: 20 entry files (~1.5 MB each), last one a syntax error -> raw preflight(150 ms)
 *     leaves unchecked; install_bundle must DENY (P013 after the retry).
 * a2: same shape, fresh dir, preflightCandidate(dir, 5 ms) must return 'uninspected' and
 *     must not pretend the file has a syntax error.
 * a3: 20 large but legal entry files -> install_bundle must ALLOW (not a blanket big-pack
 *     refusal).
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mkroot, write, makeProfile, boot } from './lib/harness.mjs';
import { preflight, lastSyntaxStatus } from '../../guard.mjs';
import { preflightCandidate } from '../../defense.mjs';

const STRICT = process.argv.includes('--strict');
const results = [];
function record(id, ok, expected, actual) {
  results.push({ id, ok, expected, actual });
  console.log(`- ${ok ? 'PASS' : 'FAIL'}  ${id} · expected: ${expected} · actual: ${actual}`);
}

function hugeBundle(root, name, broken) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1', type: 'module', main: 'a0/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n      config: {}\n`);
  for (let i = 0; i < 20; i += 1) {
    fs.mkdirSync(path.join(dir, `a${i}`), { recursive: true });
    const body = broken && i === 19
      ? 'export function apply( {\n'
      : Array.from({ length: 60000 }, (_, j) => `export const v${i}_${j} = ${j};`).join('\n');
    write(path.join(dir, `a${i}`, 'index.js'), body);
  }
  return dir;
}

async function a1(root) {
  const bundle = hugeBundle(root, 'huge-bad', true);
  const started = performance.now();
  const findings = preflight(bundle, { budgetMs: 150 });
  const ms = performance.now() - started;
  const status = lastSyntaxStatus();
  record('a1-preflight-budget-status', status.unchecked > 0, 'write-side preflight(150 ms) still leaves files unchecked (fail-open budget kept)', JSON.stringify(status));
  record('a1-preflight-no-p013', !findings.some((f) => f.ruleId === 'P013'), 'raw preflight(150 ms) does not produce P013 for unchecked files', findings.some((f) => f.ruleId === 'P013') ? 'P013 present' : `no P013 in ${findings.length} finding(s), ${ms.toFixed(1)} ms`);

  const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin'), depName: 'dev-plugin' });
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const h = await boot({ home, profileDir: profile });
  const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bundle}` } });
  const denied = Boolean(r && r.info);
  record('a1-install-refuses-broken', denied && r.info.rule === 'P013', 'install_bundle denies a syntax-broken plugin as P013', denied ? `denied ${r.info?.rule}` : 'ALLOWED (regression)');
  h.dispose();
}

function a2(root) {
  const bundle = hugeBundle(root, 'huge-inspected-5ms', true);
  const t = performance.now();
  const { finding, status } = preflightCandidate(bundle, 5);
  const actual = `${finding?.ruleId ?? 'none'} · ${status?.checked ?? '?'} checked / ${status?.unchecked ?? '?'} unchecked · ${(performance.now() - t).toFixed(1)} ms · ${String(finding?.message || '').slice(0, 60)}`;
  record('a2-tiny-budget-refuses-uninspected', finding?.ruleId === 'uninspected', 'a budget that cannot finish yields uninspected, not a fake syntax error', actual);
  record('a2-uninspected-not-syntax', !/语法错误|语法不合法|SyntaxError/i.test(String(finding?.message || '')), 'uninspected message does not claim the file has a syntax error', String(finding?.message || '—').slice(0, 90));
}

async function a3(root) {
  const bundle = hugeBundle(root, 'huge-legal', false);
  const profile = makeProfile({ root, pluginDir: path.join(root, 'workspace', 'dev-plugin2'), depName: 'dev-plugin2' });
  const home = path.join(root, 'home2');
  fs.mkdirSync(home, { recursive: true });
  const h = await boot({ home, profileDir: profile });
  const t = performance.now();
  const r = await h.callPre({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `file:${bundle}` } });
  const denied = Boolean(r && r.info);
  record('a3-large-legal-allowed', !denied, 'a large but legal bundle is allowed after the bounded retry', `${denied ? `denied ${r.info?.rule}` : 'allowed'} · ${(performance.now() - t).toFixed(1)} ms`);
  h.dispose();
}

const root = mkroot('cl-adv-');
try {
  await a1(root);
  a2(root);
  await a3(root);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
const pass = results.filter((r) => r.ok).length;
console.log(`\nsummary: ${pass} pass, ${results.length - pass} fail (adversarial)`);
fs.writeFileSync('/tmp/cl-acceptance-adversarial.json', JSON.stringify({ at: new Date().toISOString(), strict: STRICT, results }, null, 2));
if (STRICT && pass !== results.length) process.exit(1);
