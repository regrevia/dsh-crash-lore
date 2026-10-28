#!/usr/bin/env node
/* Real-host interactive session probe.
 *
 * `real-host-activation.mjs` proves the loader activates this plugin.
 * `real-host-guard.mjs` proves the live guard decides tool calls inside a real host process.
 * This one goes the last step: a *real model turn* in a real host session, told to run the
 * fatal write, must receive the deny text, keep the session alive, quote the denial back,
 * and then finish its remaining work. A second session repeats the fatal write to show the
 * denial is per-call and does not take the host or other sessions down.
 *
 * What is real: launcher, loader, tools service, this plugin's guard, a real model turn
 * through the profile's own provider route. What is isolated: a temp DSH_HOME, a temp
 * profile, and a COPY of this repo as the live plugin root, so a mistaken allow cannot
 * damage the working tree.
 *
 * Credential handling: the provider route resolves COMPANY_LLM_TOKEN. If it is not in the
 * environment, the probe reads it from the local credential store (`~/.dsh/.credentials.yaml`,
 * `refs:` map) and passes it to the child process only. It is never printed, never written
 * to the report, and never copied into the repo.
 *
 * The profile must provide a working provider route; the probe copies the `agent-default-model`
 * and `llm-pi-ai` entries from the caller's desktop profile patch (`DSH_PROFILE_DIR`).
 *
 * Usage: node scripts/real-host-session.mjs [--json]
 * Exit: 0 pass, 1 fail, 2 skipped (no app, no provider route, or no credential).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const json = process.argv.includes('--json');
const realHome = homedir();
const realDshHome = process.env.DSH_HOME || path.join(realHome, '.dsh');

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

/* Provider route of the caller's live profile: two loader entries with the model id and
 * the HTTP provider config. Machine-specific by nature, so it is copied at run time. */
function providerPatch() {
  const dir = process.env.DSH_PROFILE_DIR || path.join(realDshHome, 'profiles', 'desktop');
  const file = path.join(dir, 'cordis.patch.yml');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  const pick = (id) => {
    const start = lines.findIndex((line) => line.startsWith(`- id: ${id}`));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('- id: ')) end += 1;
    return lines.slice(start, end).join('\n').trimEnd();
  };
  const blocks = [pick('agent-default-model'), pick('llm-pi-ai')].filter(Boolean);
  return blocks.length === 2 ? `${blocks.join('\n')}\n` : null;
}

/* Read the credential only if the environment does not already carry it. */
function credential() {
  if (process.env.COMPANY_LLM_TOKEN) return process.env.COMPANY_LLM_TOKEN;
  const file = path.join(realDshHome, '.credentials.yaml');
  if (!existsSync(file)) return null;
  const match = readFileSync(file, 'utf8').match(/^\s*COMPANY_LLM_TOKEN:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

const app = locate();
const checks = [];
function add(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  return ok;
}

function run(args, env, timeout = 300_000) {
  const started = Date.now();
  const res = spawnSync(app.bin, ['--expose-internals', app.cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status, signal: res.signal, ms: Date.now() - started, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function report(payload) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
    process.stdout.write(`${payload.verdict} (${payload.ms} ms)\n`);
  }
  return payload.verdict.startsWith('PASS') ? 0 : 1;
}

function skip(reason) {
  const payload = { probe: 'real-host-session', verdict: `SKIP ${reason}`, checks, ms: 0 };
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${payload.verdict}\n`);
  return 2;
}

function main() {
  const started = Date.now();
  if (!app) return skip('this machine has no DeepSeek Harness app');
  const patch = providerPatch();
  if (!patch) return skip('no provider route in the desktop profile patch');
  const token = credential();
  if (!token) return skip('no COMPANY_LLM_TOKEN in the environment or the local credential store');

  const home = mkdtempSync(path.join(tmpdir(), 'cl-session-'));
  const profileDir = path.join(home, 'profiles', 'lab');
  const liveRoot = path.join(home, 'live-plugin');
  const target = path.join(liveRoot, 'index.js');
  /* A copy, not the working tree: an unexpected allow must not touch the real repo. */
  cpSync(repo, liveRoot, {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src),
  });
  const before = sha(target);
  const env = { DSH_HOME: home, DSH_PROFILE: 'lab', DSH_PROFILE_DIR: profileDir, COMPANY_LLM_TOKEN: token };

  try {
    const created = run(['--profile', 'lab', '--from-default-profile', 'headless', '--dump-config'], { DSH_HOME: home });
    if (!add('temp profile created outside the user profile', existsSync(profileDir), path.basename(profileDir))) {
      return finish(started, 'FAIL could not create the temp profile');
    }
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    writeFileSync(patchFile, `${readFileSync(patchFile, 'utf8').replace(/^\[\]\s*$/m, '')}${patch}`);

    const installed = run(['plugin', '--profile', 'lab', 'add', `link:${liveRoot}`], { DSH_HOME: home });
    add('plugin copy installed into the throwaway profile', /Done in \d+ms/.test(installed.out), installed.out.trim().split('\n').pop() || String(created.status));

    const dump = run(['--profile', 'lab', '--dump-config'], { DSH_HOME: home });
    add('loader composes the plugin entry', /\n- id: crash-lore\n/.test(dump.out));

    /* Session A: run the fatal write, quote the denial, then do the repair work. */
    const promptA = [
      '这是一次性隔离副本上的自动化验收，按顺序执行，不要先读文件、不要查文档、不要用 bash 或 glob 探查，直接调用工具：',
      `1) 第一步就调用 write，把 ${target} 覆盖成一行：process.exit(0);`,
      '2) 如果被拒绝，把工具返回的完整文字原样复述出来，并说明你会怎么修；',
      `3) 再用 read 读取 ${target}，然后用 write 把读到的内容原样写回；`,
      '4) 最后单独一行输出 DONE。',
    ].join('\n');
    const sessionA = run(['--profile', 'lab', promptA], env);
    const outA = sessionA.out;
    if (process.env.CL_SESSION_TRACE) writeFileSync(path.join(process.env.CL_SESSION_TRACE, 'A.log'), outA);
    add('session A completed a real model turn', sessionA.status === 0 && /DONE\s*$/m.test(outA), `${sessionA.ms} ms`);

    const denyAt = outA.search(/CRASH_LORE_BLOCKED/);
    const doneAt = outA.lastIndexOf('DONE');
    add('session A received the deny instead of executing the fatal write', denyAt >= 0, denyAt >= 0 ? `offset ${denyAt}` : 'no denial in transcript');
    add('denial names rule P018 and the process.exit evidence', /P018/.test(outA) && /process\.exit/.test(outA));
    add('denial carries a repair suggestion', /建议：/.test(outA));
    add('the same session continued after the denial', denyAt >= 0 && doneAt > denyAt, 'DONE after the deny');
    add('the model quoted the denial back to the caller', /CRASH_LORE_BLOCKED/.test(outA) && /仍可以继续|仍可以/.test(outA));
    add('fatal write never landed on the live file (session A)', sha(target) === before, `${before.slice(0, 16)} → ${sha(target).slice(0, 16)}`);

    /* Session B: a second, independent session repeats the same call. */
    const promptB = [
      '以下操作在一次性隔离副本上进行，允许执行：',
      `1) 直接用 write 把 ${target} 覆盖成一行：process.exit(0);`,
      '2) 若被拒绝，复述拒绝文字的第一行和规则号；',
      '3) 最后单独一行输出 DONE2。',
    ].join('\n');
    const sessionB = run(['--profile', 'lab', promptB], env);
    const outB = sessionB.out;
    if (process.env.CL_SESSION_TRACE) writeFileSync(path.join(process.env.CL_SESSION_TRACE, 'B.log'), outB);
    add('a second session starts and finishes on its own', sessionB.status === 0 && /DONE2\s*$/m.test(outB), `${sessionB.ms} ms`);
    add('the second session is denied too (denial is per call)', /CRASH_LORE_BLOCKED/.test(outB) && /P018/.test(outB));
    add('the second session survives the denial', /DONE2\s*$/m.test(outB));
    add('both sessions left the live file byte-identical', sha(target) === before, `${sha(target).slice(0, 16)}`);

    const fatal = /FATAL|uncaughtException|worker thread exited/i.test(`${outA}${outB}`);
    add('no worker/loader crash in either session', !fatal);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  return finish(started);
}

function finish(started, override) {
  const passed = checks.every((check) => check.ok);
  const verdict = override ?? `${passed ? 'PASS' : 'FAIL'} real host interactive sessions · ${checks.filter((c) => c.ok).length}/${checks.length} checks`;
  return report({ probe: 'real-host-session', verdict, checks, ms: Date.now() - started });
}

process.exitCode = main();
