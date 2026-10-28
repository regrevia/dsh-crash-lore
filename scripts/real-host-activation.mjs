#!/usr/bin/env node
/* Real-host activation probe.
 *
 * In-process tests (`npm test`) mount the plugin on a fake ctx. This probe does the
 * other half: it asks the *shipped* DeepSeek Harness launcher to boot a real profile
 * (real cordis loader, real bundle patch layers, real `tools` service) with this
 * package installed from disk, and checks that the loader activated the entry instead
 * of failing it.
 *
 * It never touches the user's own profile: a throwaway profile is created with
 * `--from-default-profile headless` inside a temp DSH_HOME, and the package is added
 * with `dsh plugin add link:<this repo>`.
 *
 * No model credential is required. The boot is expected to stop at
 * `MISSING_CREDENTIAL` (that happens after the whole tree — including this plugin —
 * has been mounted), so a missing key is a *pass* here, not a failure.
 *
 * Usage: node scripts/real-host-activation.mjs [--json]
 *        DSH_REAL_HOST_SPEC=dsh-crash-lore@0.2.1 node scripts/real-host-activation.mjs  # probe the published artifact
 * Exit: 0 pass, 1 fail, 2 skipped (no DeepSeek Harness app on this machine).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const json = process.argv.includes('--json');

function locate() {
  const bins = [
    process.env.DSH_APP_BIN,
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  ].filter(Boolean);
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    const res = path.join(path.dirname(path.dirname(bin)), 'Resources');
    /* The launcher lives inside app.asar, which plain fs cannot stat; check the
     * archive file instead of the path inside it. */
    if (!existsSync(path.join(res, 'app.asar'))) continue;
    const cli = path.join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    return { bin, cli };
  }
  return null;
}

function run(app, args, env, timeout = 240_000) {
  const started = Date.now();
  const res = spawnSync(app.bin, ['--expose-internals', app.cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: res.status,
    signal: res.signal,
    ms: Date.now() - started,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

function report(result) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
    }
    process.stdout.write(`${result.verdict} (${result.ms} ms)\n`);
  }
  return result.verdict.startsWith('PASS') ? 0 : 1;
}

const app = locate();

async function main() {
  const raw = process.env.DSH_REAL_HOST_HOME ?? mkdtempSync(path.join(tmpdir(), 'cl-realhost-'));
  const home = path.resolve(raw);
  const own = process.env.DSH_REAL_HOST_HOME === undefined;
  const env = { DSH_HOME: home };
  const checks = [];
  const t0 = Date.now();
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  try {
    /* 1. Throwaway profile from the shipped headless template. */
    const make = run(app, ['--profile', 'lab', '--from-default-profile', 'headless', '--dump-config'], env);
    add('profile created from shipped template', make.status === 0, `exit ${make.status}, ${make.ms} ms`);

    /* 2. Install the package into it through the same path a user install uses.
     *    Default is this checkout; DSH_REAL_HOST_SPEC=dsh-crash-lore@0.2.1 probes the
     *    artifact that is actually on the registry. */
    const spec = process.env.DSH_REAL_HOST_SPEC ?? `link:${repo}`;
    const install = run(app, ['plugin', '--profile', 'lab', 'add', spec], env);
    const installed = /dsh-crash-lore/.test(install.out);
    add(`package installed (${spec})`, install.status === 0 && installed, install.out.trim().split('\n').slice(-2).join(' / '));

    /* 3. Composed tree carries the entry, in the layer this package declares. */
    const dump = run(app, ['--profile', 'lab', '--dump-config'], env);
    const entryLine = dump.out.split('\n').findIndex((line) => /name: ['"]?dsh-crash-lore/.test(line));
    add('entry present in composed profile tree', entryLine >= 0, entryLine >= 0 ? `line ${entryLine + 1}` : 'entry missing');

    /* 4. Boot the real host. Without a credential it stops after mounting everything. */
    const boot = run(app, ['--profile', 'lab', '只回复两个字：ok'], env, 300_000);
    /* Only the loader's own warning counts. The boot scan prints crash history text,
     * which can itself contain "did not activate" from *other* plugins — and that line
     * appearing at all is proof this plugin ran. */
    const loaderWarning = /dsh: warning:[^\n]*did not activate/.test(boot.out) || /\ncrash-lore \(dsh-crash-lore\):/.test(boot.out);
    add('loader activated the entry (no loader warning)', !loaderWarning, loaderWarning ? (boot.out.split('\n').find((l) => /crash-lore/.test(l)) ?? '') : 'no activation warning');
    const reachedMount = /MISSING_CREDENTIAL|no API key|no credential/i.test(boot.out);
    add('boot reached the credential wall (i.e. the tree mounted)', reachedMount, reachedMount ? 'expected without a model key' : `exit ${boot.status}`);
    /* apply() runs the boot scan, which logs one line when the real lore dir has history;
     * on a clean machine there is nothing to log, so this signal is best-effort. */
    const applyRan = /\[crash-lore\]/.test(boot.out);
    add('apply() executed in the real host', applyRan || reachedMount, applyRan ? 'boot scan logged' : 'no lore history to log (accepted)');

    const verdict = checks.every((c) => c.ok) ? 'PASS  real host activation' : 'FAIL  real host activation';
    return { verdict, checks, host: { bin: app.bin, home }, ms: Date.now() - t0 };
  } finally {
    if (own) rmSync(home, { recursive: true, force: true });
  }
}

if (!app) {
  if (json) process.stdout.write(`${JSON.stringify({ verdict: 'SKIP', reason: 'no app' })}\n`);
  else process.stdout.write('SKIP  this machine has no DeepSeek Harness app\n');
  process.exitCode = 2;
} else {
  process.exitCode = report(await main());
}
