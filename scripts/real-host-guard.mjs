#!/usr/bin/env node
/* Real-host guard probe.
 *
 * `real-host-activation.mjs` proves the shipped loader *activates* this plugin. This one
 * proves the activated plugin actually decides tool calls inside a real host process:
 * a throwaway fixture plugin calls the host's own `ctx.tools.execute()` once the `tools`
 * service is mounted, and we read what the real pipeline answered.
 *
 * What is real here: the DeepSeek Harness launcher, the cordis loader and bundle layers,
 * the `tools` service, this plugin's `tools.guard` hook, and the deny payload the caller
 * receives. What is not: no model turn is involved (the boot stops at MISSING_CREDENTIAL
 * after the tree is mounted), so the *same-session continuation* half of the contract is
 * out of scope here and is only covered after a real restart.
 *
 * The probe never writes to the user's profile: everything lives in a temp DSH_HOME, and
 * the file the fixture tries to corrupt is this repo's own `index.js`, whose sha256 is
 * compared before and after. A denied write must leave it byte-identical.
 *
 * One unrelated host policy is switched off in the throwaway profile:
 * `fs-observation-policy` (read-before-write). In a real session it would answer the
 * retry with FS_NOT_OBSERVED before the file is touched, which hides whether this
 * plugin allowed the corrected call. Disabling it changes no crash-lore decision: the
 * deny cases are produced by crash-lore's own guard, which runs first).
 *
 * Usage: node scripts/real-host-guard.mjs [--json]
 * Exit: 0 pass, 1 fail, 2 skipped (no DeepSeek Harness app on this machine).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(repo, 'scripts', 'fixtures', 'guard-probe');
const target = path.join(repo, 'index.js');
const json = process.argv.includes('--json');

function locate() {
  const bins = [process.env.DSH_APP_BIN, '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'].filter(Boolean);
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    const res = path.join(path.dirname(path.dirname(bin)), 'Resources');
    /* cli.js lives inside app.asar, which plain fs cannot stat. */
    if (!existsSync(path.join(res, 'app.asar'))) continue;
    const cli = path.join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    return { bin, cli };
  }
  return null;
}

const app = locate();
const checks = [];

function add(name, ok, detail) {
  checks.push({ name, ok, detail });
  return ok;
}

function run(args, env, timeout = 240_000) {
  const started = Date.now();
  const res = spawnSync(app.bin, ['--expose-internals', app.cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: res.status, signal: res.signal, ms: Date.now() - started, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function reportEarly(started) {
  return report({
    probe: 'real-host-guard',
    verdict: `FAIL real host process · ${checks.filter((check) => check.ok).length}/${checks.length} checks`,
    checks,
    ms: Date.now() - started,
  });
}

function report(report_) {
  if (json) process.stdout.write(`${JSON.stringify(report_, null, 2)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
    process.stdout.write(`${report_.verdict} (${report_.ms} ms)\n`);
  }
  return report_.verdict.startsWith('PASS') ? 0 : 1;
}

function main() {
  if (!app) {
    const skipped = { probe: 'real-host-guard', verdict: 'SKIP this machine has no DeepSeek Harness app', checks, ms: 0 };
    if (json) process.stdout.write(`${JSON.stringify(skipped, null, 2)}\n`);
    else process.stdout.write(`${skipped.verdict}\n`);
    return 2;
  }
  const started = Date.now();
  const home = mkdtempSync(path.join(tmpdir(), 'cl-guard-'));
  const profileDir = path.join(home, 'profiles', 'lab');
  const outFile = path.join(home, 'guard-probe.json');
  const benign = path.join(home, 'benign.txt');
  const before = sha(target);
  try {
    const create = run(['--profile', 'lab', '--from-default-profile', 'headless', '--dump-config'], { DSH_HOME: home });
    if (!add('profile created in a temp DSH_HOME', existsSync(profileDir), profileDir)) return reportEarly(started);

    /* Read-before-write is a separate host policy; switching it off in the throwaway
     * profile lets the corrected retry actually reach the file. */
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    writeFileSync(patchFile, `${readFileSync(patchFile, 'utf8').replace(/^\[\]\s*$/m, '')}- id: fs-observation-policy\n  disabled: true\n`);
    const addRepo = run(['plugin', '--profile', 'lab', 'add', `link:${repo}`], { DSH_HOME: home });
    const addFixture = run(['plugin', '--profile', 'lab', 'add', `link:${fixture}`], { DSH_HOME: home });
    add('this package installed as a profile layer', /Done in \d+ms/.test(addRepo.out), addRepo.out.trim().split('\n').pop());
    add('guard-probe fixture installed', /Done in \d+ms/.test(addFixture.out), addFixture.out.trim().split('\n').pop());

    const dump = run(['--profile', 'lab', '--dump-config'], { DSH_HOME: home });
    add('loader composes both entries', /\n- id: crash-lore\n/.test(dump.out) && /\n- id: crash-lore-guard-probe\n/.test(dump.out));
    add('unrelated read-before-write policy disabled for the loop check', /- id: fs-observation-policy\n  name: '@deepseek-ai\/dsh-fs-observation-policy'[\s\S]{0,80}?disabled: true/.test(dump.out));

    const bootEnv = {
      DSH_HOME: home,
      DSH_PROFILE: 'lab',
      DSH_PROFILE_DIR: profileDir,
      CL_PROBE_OUT: outFile,
      CL_PROBE_TARGET: target,
      CL_PROBE_BENIGN: benign,
    };
    const boot = run(['--profile', 'lab', '只回复两个字：ok'], bootEnv, 300_000);
    add('real host mounted the tree (stops only at the credential gate)', /MISSING_CREDENTIAL|no API key/i.test(boot.out), `${boot.ms} ms`);

    let probe = null;
    try {
      probe = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch {
      add('fixture reached the real tools service', false, 'fixture wrote no result');
      return reportEarly(started);
    }
    const byLabel = Object.fromEntries(probe.results.map((entry) => [entry.label, entry]));
    add('fixture reached the real tools service', true, `${probe.results.length} call(s)`);

    const benignResult = byLabel['benign-create'];
    add('innocent write executed (no over-blocking)', benignResult?.isError === false && existsSync(benign), benignResult?.threw ? String(benignResult.threw).slice(0, 80) : '');

    const denied = byLabel['dangerous-syntax'];
    const denial = String(denied?.text ?? denied?.threw ?? '');
    add('dangerous write rejected by the live guard', denied?.isError === true, '');
    add('denial came from this plugin, not another layer', /CRASH_LORE_BLOCKED/.test(denial) && /dsh-crash-lore/.test(denial), '');
    add('denial names the rule and the reason', /P013/.test(denial) && /语法不合法/.test(denial), '');
    add('denial tells the caller what to do next', /建议：/.test(denial) && /仍可以/.test(denial), '');

    const runtimeDenied = byLabel['dangerous-runtime'];
    const runtimeText = String(runtimeDenied?.text ?? runtimeDenied?.threw ?? '');
    add('valid-JS crash shape rejected on the live file too', runtimeDenied?.isError === true && /P018/.test(runtimeText) && /process\.exit/.test(runtimeText), '');

    const corrected = byLabel['corrected'];
    add('corrected retry from the same caller succeeds', corrected?.isError === false, String(corrected?.threw ?? corrected?.head ?? '').slice(0, 80));
    add('denial returns to the caller instead of crashing the host', boot.signal === null && byLabel['benign-create'] !== undefined, '');

    const after = sha(target);
    add('denied file is byte-identical afterwards', before === after, `${before.slice(0, 16)} → ${after.slice(0, 16)}`);

    const fatal = /FATAL|uncaughtException|worker thread exited/i.test(boot.out);
    add('no worker/loader crash during the probe', !fatal, '');
    globalThis.__clCalls = probe.results.map((entry) => ({ label: entry.label, isError: entry.isError === true, threw: entry.threw, head: String(entry.text ?? '').slice(0, 160) }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const passed = checks.every((check) => check.ok);
  const result = {
    probe: 'real-host-guard',
    calls: (globalThis.__clCalls ?? []),
    verdict: `${passed ? 'PASS' : 'FAIL'} real host process · ${checks.filter((c) => c.ok).length}/${checks.length} checks`,
    checks,
    ms: Date.now() - started,
  };
  return report(result);
}

process.exitCode = main();
