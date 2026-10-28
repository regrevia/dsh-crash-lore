/**
 * Test fixture, never shipped: drives the real host's own tool pipeline once it is mounted,
 * so `scripts/real-host-guard.mjs` can observe what the live guard actually decides.
 * Paths and the result file arrive through the environment; nothing here is product code.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preflight } from '../../../guard.mjs';

export const name = 'dsh-crash-lore-guard-probe';
export const inject = ['tools'];

export function apply(ctx) {
  const out = process.env.CL_PROBE_OUT ?? '/tmp/cl-guard-probe.json';
  const target = process.env.CL_PROBE_TARGET ?? '';
  const benign = process.env.CL_PROBE_BENIGN ?? '/tmp/cl-guard-probe-benign.txt';
  const results = [];
  let original = '';
  try {
    original = target ? readFileSync(target, 'utf8') : '';
  } catch {
    original = '';
  }
  const agentId = process.env.CL_PROBE_AGENT_ID;
  const agent = agentId ? { id: agentId, cwd: process.cwd(), session: { id: `${agentId}-session`, cwd: process.cwd() } } : undefined;
  const flush = () => writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), target, benign, results }, null, 2));
  const call = async (label, tool, args) => {
    const entry = { label, tool };
    try {
      const result = await ctx.tools.execute({
        name: tool,
        arguments: args,
        callId: `probe-${label}`,
        signal: new AbortController().signal,
        ...(agent ? { agent } : {}),
      });
      entry.isError = result?.isError === true;
      entry.text = JSON.stringify(result).slice(0, 1200);
    } catch (error) {
      entry.threw = String(error?.message ?? error).slice(0, 400);
    }
    results.push(entry);
    flush();
  };
  /* Real-host preflight timing: the shipped guard module, a package with 20 entry files,
   * measured in the host's own process (same fixture shape as `c14-perf`). */
  const timing = [];
  try {
    const root = mkdtempSync(path.join(tmpdir(), 'cl-preflight-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'perf-20-entries', version: '1.0.0', type: 'module', main: 'index.js' }));
      writeFileSync(path.join(root, 'cordis.patch.yml'), '- insert:\n    - id: perf\n      name: perf-20-entries\n      config: {}\n');
      writeFileSync(path.join(root, 'index.js'), 'export function apply() {}\n');
      for (let i = 1; i <= 20; i += 1) {
        const dir = path.join(root, `feature-${String(i).padStart(2, '0')}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'index.js'), "import path from 'node:path';\nexport function apply(ctx) {\n  ctx.effect(() => () => {});\n}\n");
      }
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        const findings = preflight(root);
        timing.push({ ms: Number((performance.now() - started).toFixed(2)), findings: findings.length });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } catch (error) {
    timing.push({ error: String(error?.message ?? error).slice(0, 300) });
  }
  writeFileSync(out.replace(/\.json$/, '-preflight.json'), JSON.stringify({ at: new Date().toISOString(), timing }, null, 2));
  flush();
  setTimeout(async () => {
    await call('benign-create', 'write', { file_path: benign, content: 'benign probe\n' });
    await call('dangerous-syntax', 'write', { file_path: target, content: '# not valid javascript\n' });
    await call('read-live', 'read', { file_path: target });
    await call('dangerous-runtime', 'write', { file_path: target, content: 'process.exit(0);\n' });
    if (original) await call('corrected', 'write', { file_path: target, content: original });
  }, 40);
}
