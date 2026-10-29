/**
 * Test fixture, never shipped. Asks the real host's tool pipeline to write the same
 * protected file through four different address forms (absolute, session-relative,
 * symlink, and a benign symlink to a scratch file). `scripts/real-host-resolve.mjs`
 * reads the answers and checks the protected file's bytes.
 */
import { writeFileSync } from 'node:fs';

export const name = 'dsh-lifeguard-resolve-probe';
export const inject = ['tools'];

const BAD = '# not valid javascript\n';

export function apply(ctx) {
  const out = process.env.CL_PROBE_OUT ?? '/tmp/cl-resolve-probe.json';
  const repo = process.env.CL_PROBE_REPO ?? '';
  const rel = process.env.CL_PROBE_REL ?? '';
  const link = process.env.CL_PROBE_LINK ?? '';
  const scratch = process.env.CL_PROBE_SCRATCH ?? '';
  const scratchLink = process.env.CL_PROBE_SCRATCH_LINK ?? '';
  const second = process.env.CL_PROBE_SECOND ?? '';
  const secondBenign = process.env.CL_PROBE_SECOND_BENIGN ?? '';
  const results = [];
  const cwd = process.cwd();
  const flush = () => writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), cwd, results }, null, 2));
  const call = async (label, tool, args, withAgent = true) => {
    const entry = { label, tool, args: { ...args, content: args.content === undefined ? undefined : `<${args.content.length} chars>` } };
    try {
      const result = await ctx.tools.execute({
        name: tool,
        arguments: args,
        callId: `probe-${label}`,
        signal: new AbortController().signal,
        ...(withAgent ? { agent: { id: 'resolve-probe', cwd, session: { id: 'resolve-probe-session', cwd } } } : {}),
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
    await call('scratch-baseline', 'write', { file_path: scratch, content: 'scratch baseline\n' }, false);
    await call('absolute-deny', 'write', { file_path: repo, content: BAD });
    await call('relative-deny', 'write', { file_path: rel, content: BAD });
    await call('symlink-deny', 'write', { file_path: link, content: BAD });
    await call('scratch-symlink-benign', 'write', { file_path: scratchLink, content: 'through a symlink\n' }, false);
    /* Protection scope: a second, unrelated plugin installed in the same profile. */
    await call('second-plugin-deny', 'write', { file_path: second, content: BAD });
    await call('second-plugin-benign', 'write', { file_path: secondBenign, content: 'beside a plugin\n' }, false);
  }, 40);
}
