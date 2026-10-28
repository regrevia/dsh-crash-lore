#!/usr/bin/env node
/* Real-host resolution probe.
 *
 * The in-process matrix proves the guard resolves session-relative paths and symlinks
 * against the live plugin root. This probe asks a real host process the same question
 * through the real tool pipeline: a fixture plugin writes the protected file four ways
 * (absolute, session-relative from a different cwd, symlink, and a benign symlink to a
 * scratch file), then writes a second unrelated plugin installed in the same profile, so
 * the protected set is proven to come from the profile entries and not from this root alone. The protected file must stay byte-identical and the benign writes must
 * land, all without a model turn.
 *
 * Everything lives in a temp DSH_HOME. The protected file is this repo's own `index.js`;
 * its bytes are backed up and restored in `finally`, so a guard miss cannot leave damage.
 *
 * Usage: node scripts/real-host-resolve.mjs [--json]
 * Exit: 0 pass, 1 fail, 2 skipped (no DeepSeek Harness app on this machine).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(repoRoot, 'scripts', 'fixtures', 'resolve-probe');
const secondPluginName = 'dsh-crash-lore-second-probe';
const protectedFile = path.join(repoRoot, 'index.js');
const json = process.argv.includes('--json');
const checks = [];

function locate() {
  const bins = [process.env.DSH_APP_BIN, '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'].filter(Boolean);
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    const res = path.join(path.dirname(path.dirname(bin)), 'Resources');
    if (!existsSync(path.join(res, 'app.asar'))) continue;
    const cli = path.join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    return { bin, cli };
  }
  return null;
}

const app = locate();

function add(name, ok, detail) {
  checks.push({ name, ok, detail });
  return ok;
}

function run(args, env, options = {}) {
  const started = Date.now();
  const res = spawnSync(app.bin, ['--expose-internals', app.cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: res.status, signal: res.signal, ms: Date.now() - started, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function report(result) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
    process.stdout.write(`${result.verdict} (${result.ms} ms)\n`);
  }
  return result.verdict.startsWith('PASS') ? 0 : 1;
}

function main() {
  if (!app) {
    const skipped = { probe: 'real-host-resolve', verdict: 'SKIP this machine has no DeepSeek Harness app', checks, ms: 0 };
    if (json) process.stdout.write(`${JSON.stringify(skipped, null, 2)}\n`);
    else process.stdout.write(`${skipped.verdict}\n`);
    return 2;
  }
  const started = Date.now();
  const home = mkdtempSync(path.join(tmpdir(), 'cl-resolve-'));
  const profileDir = path.join(home, 'profiles', 'lab');
  const outFile = path.join(home, 'resolve-probe.json');
  const scratch = path.join(home, 'scratch.txt');
  const link = path.join(home, 'linked-index.js');
  const scratchLink = path.join(home, 'scratch-link.txt');
  const secondRoot = path.join(home, 'second-plugin');
  const secondEntry = path.join(secondRoot, 'index.js');
  const secondBenign = path.join(secondRoot, 'notes.txt');
  const originalBytes = readFileSync(protectedFile);
  const before = sha(protectedFile);
  try {
    const create = run(['--profile', 'lab', '--from-default-profile', 'headless', '--dump-config'], { DSH_HOME: home });
    if (!add('profile created in a temp DSH_HOME', existsSync(profileDir), profileDir)) {
      return report({ probe: 'real-host-resolve', verdict: `FAIL · ${checks.filter((c) => c.ok).length}/${checks.length}`, checks, ms: Date.now() - started });
    }
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    writeFileSync(patchFile, `${readFileSync(patchFile, 'utf8').replace(/^\[\]\s*$/m, '')}- id: fs-observation-policy\n  disabled: true\n`);
    const addRepo = run(['plugin', '--profile', 'lab', 'add', `link:${repoRoot}`], { DSH_HOME: home });
    const addFixture = run(['plugin', '--profile', 'lab', 'add', `link:${fixture}`], { DSH_HOME: home });
    add('this package installed as a profile layer', /Done in \d+ms/.test(addRepo.out), addRepo.out.trim().split('\n').pop());
    add('resolve-probe fixture installed', /Done in \d+ms/.test(addFixture.out), addFixture.out.trim().split('\n').pop());

    /* A second, unrelated plugin in the same profile: the guard's protected set must come
     * from the installed profile entries, not from this package's own root. */
    mkdirSync(secondRoot, { recursive: true });
    writeFileSync(path.join(secondRoot, 'package.json'), JSON.stringify({ name: secondPluginName, version: '0.0.0', private: true, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2));
    writeFileSync(path.join(secondRoot, 'cordis.patch.yml'), '- insert:\n    - id: crash-lore-second-probe\n      name: dsh-crash-lore-second-probe\n      config: {}\n');
    writeFileSync(secondEntry, 'export function apply() {}\n');
    const secondBefore = sha(secondEntry);
    const addSecond = run(['plugin', '--profile', 'lab', 'add', `link:${secondRoot}`], { DSH_HOME: home });
    add('second unrelated plugin installed', /Done in \d+ms/.test(addSecond.out), addSecond.out.trim().split('\n').pop());

    symlinkSync(protectedFile, link);
    symlinkSync(scratch, scratchLink);
    add('symlink really points at the protected file', readlinkSync(link) === protectedFile, link);
    const relative = `${path.basename(repoRoot)}/index.js`;

    const dump = run(['--profile', 'lab', '--dump-config'], { DSH_HOME: home });
    add('loader composes all three entries', /\n- id: crash-lore\n/.test(dump.out) && /\n- id: crash-lore-resolve-probe\n/.test(dump.out) && /\n- id: crash-lore-second-probe\n/.test(dump.out), '');

    const bootEnv = {
      DSH_HOME: home,
      DSH_PROFILE: 'lab',
      DSH_PROFILE_DIR: profileDir,
      CL_PROBE_OUT: outFile,
      CL_PROBE_REPO: protectedFile,
      CL_PROBE_REL: relative,
      CL_PROBE_LINK: link,
      CL_PROBE_SCRATCH: scratch,
      CL_PROBE_SCRATCH_LINK: scratchLink,
      CL_PROBE_SECOND: secondEntry,
      CL_PROBE_SECOND_BENIGN: secondBenign,
    };
    /* The host's cwd is the session cwd: the parent of this repo, so the relative form
     * resolves to the same protected file through a path the guard never saw installed. */
    const boot = run(['--profile', 'lab', '只回复两个字：ok'], bootEnv, { cwd: path.dirname(repoRoot), timeout: 300_000 });
    add('real host mounted the tree (stops only at the credential gate)', /MISSING_CREDENTIAL|no API key/i.test(boot.out), `${boot.ms} ms`);

    let probe = null;
    try {
      probe = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch {
      add('fixture reached the real tools service', false, 'fixture wrote no result');
      return report({ probe: 'real-host-resolve', verdict: `FAIL · ${checks.filter((c) => c.ok).length}/${checks.length}`, checks, ms: Date.now() - started });
    }
    const byLabel = Object.fromEntries(probe.results.map((entry) => [entry.label, entry]));
    add('fixture reached the real tools service', true, `${probe.results.length} call(s)`);
    add('session cwd is the repo parent', path.resolve(probe.cwd) === path.dirname(repoRoot), probe.cwd);

    const text = (label) => String(byLabel[label]?.text ?? byLabel[label]?.threw ?? '');
    add('benign scratch write executed (no over-blocking)', byLabel['scratch-baseline']?.isError === false && existsSync(scratch), '');
    add('absolute path to the protected file is denied', byLabel['absolute-deny']?.isError === true && /P013/.test(text('absolute-deny')), '');
    add('session-relative path is denied too', byLabel['relative-deny']?.isError === true && /P013/.test(text('relative-deny')), text('relative-deny').slice(0, 120));
    add('symlinked path is denied too', byLabel['symlink-deny']?.isError === true && /P013/.test(text('symlink-deny')), text('symlink-deny').slice(0, 120));
    add('denials come from this plugin', ['absolute-deny', 'relative-deny', 'symlink-deny'].every((label) => /CRASH_LORE_BLOCKED/.test(text(label)) && /dsh-crash-lore/.test(text(label))), '');
    add('benign write through a symlink still lands', byLabel['scratch-symlink-benign']?.isError === false && readFileSync(scratch, 'utf8').includes('through a symlink'), '');
    add('second plugin\'s entry is denied too (scope from the profile)', byLabel['second-plugin-deny']?.isError === true && /P013/.test(text('second-plugin-deny')) && /CRASH_LORE_BLOCKED/.test(text('second-plugin-deny')), text('second-plugin-deny').slice(0, 120));
    add('second plugin file byte-identical afterwards', secondBefore === sha(secondEntry), `${secondBefore.slice(0, 16)} → ${sha(secondEntry).slice(0, 16)}`);
    add('benign write beside the second plugin lands', byLabel['second-plugin-benign']?.isError === false && existsSync(secondBenign), '');
    add('protected file is byte-identical afterwards', before === sha(protectedFile), `${before.slice(0, 16)} → ${sha(protectedFile).slice(0, 16)}`);
    const fatal = /FATAL|uncaughtException|worker thread exited/i.test(boot.out);
    add('no worker/loader crash during the probe', !fatal, '');
    const passed = checks.every((check) => check.ok);
    return report({
      probe: 'real-host-resolve',
      calls: probe.results.map((entry) => ({ label: entry.label, isError: entry.isError === true, threw: entry.threw, head: text(entry.label).slice(0, 160) })),
      verdict: `${passed ? 'PASS' : 'FAIL'} real host process · ${checks.filter((c) => c.ok).length}/${checks.length} checks`,
      checks,
      ms: Date.now() - started,
    });
  } finally {
    writeFileSync(protectedFile, originalBytes);
    rmSync(home, { recursive: true, force: true });
  }
}

process.exitCode = main();
