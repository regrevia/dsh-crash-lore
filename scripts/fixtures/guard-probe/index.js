/**
 * Test fixture, never shipped: drives the real host's own tool pipeline once it is mounted,
 * so `scripts/real-host-guard.mjs` can observe what the live guard actually decides.
 * Paths and the result file arrive through the environment; nothing here is product code.
 */
import { readFileSync, writeFileSync } from 'node:fs';

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
  flush();
  setTimeout(async () => {
    await call('benign-create', 'write', { file_path: benign, content: 'benign probe\n' });
    await call('dangerous-syntax', 'write', { file_path: target, content: '# not valid javascript\n' });
    await call('read-live', 'read', { file_path: target });
    await call('dangerous-runtime', 'write', { file_path: target, content: 'process.exit(0);\n' });
    if (original) await call('corrected', 'write', { file_path: target, content: original });
  }, 40);
}
