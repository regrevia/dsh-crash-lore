import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const events = [
  { type: 'turn/start', time: 1, data: { turn: 1 } },
  { type: 'request/header', time: 2, data: { header: { config: { provider: 'deepseek', model: 'v4' } } } },
  { type: 'user/message', time: 3, data: { message: { content: [{ type: 'text', text: '把底部状态圈换成圆环' }] } } },
  { type: 'tool/call', time: 4, data: { name: 'read', arguments: '{"path":"/a/b.mjs"}' } },
  { type: 'tool/result', time: 5, data: { message: { content: [{ type: 'text', text: '文件内容' }] } } },
  { type: 'assistant/message', time: 6, data: { message: { content: [{ type: 'text', text: '改完了' }] } } },
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crash-lore-handoff-'));
}

/** 假宿主：记录会话服务每次调用，llm 由用例自己给。 */
function fakeHost({ llm } = {}) {
  const calls = {
    inspect: [],
    create: [],
    rename: [],
    prompt: [],
    archive: [],
    prepare: [],
    stream: [],
  };
  const sessionController = {
    async list() {
      return { items: [{ sessionId: 'parent-1', running: false }] };
    },
    async inspect(sessionId) {
      calls.inspect.push(sessionId);
      return { events, meta: { cwd: '/tmp' } };
    },
    async create(seed) {
      calls.create.push(seed);
      return { sessionId: 'child-1' };
    },
    async rename(args) {
      calls.rename.push(args);
    },
    async prompt(args) {
      calls.prompt.push(args);
    },
    async archiveSession(args) {
      calls.archive.push(args);
    },
  };
  const workspaceController = {
    async archiveSession(args) {
      calls.archive.push(args);
    },
  };
  const services = { sessionController, workspaceController };
  if (llm) {
    services.llm = {
      async prepareCall(request, signal) {
        calls.prepare.push({ request, signal });
        return {
          config: { provider: request.provider, model: request.model, maxTokens: request.maxTokens },
          stream: llm.stream,
        };
      },
    };
  }
  return { calls, services };
}

function makeContext(services) {
  const registered = [];
  const tools = {
    registered,
    register(tool) {
      registered.push(tool);
      return () => {};
    },
    guard() {
      return () => {};
    },
  };
  const disposers = [];
  const ctx = {
    tools,
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    on() {
      return () => {};
    },
    get(key) {
      return services[key];
    },
    dispose() {
      while (disposers.length) disposers.pop()();
    },
  };
  return ctx;
}

function handoffTool(ctx) {
  return ctx.tools.registered.find((tool) => tool.name === 'crash_lore_handoff');
}

async function run({ llm, args = {}, services: given } = {}) {
  const home = tmp();
  const host = fakeHost({ llm });
  const ctx = makeContext({ ...host.services, ...given });
  apply(ctx, { home });
  const tool = handoffTool(ctx);
  assert.ok(tool, 'crash_lore_handoff 应该注册上');
  const signal = new AbortController().signal;
  const result = await tool.execute({ sessionId: 'parent-1', ...args }, { signal });
  ctx.dispose();
  return { result, calls: host.calls, home };
}

const goodStream = async function* () {
  yield { type: 'text-delta', text: '## 目标\n' };
  yield { type: 'text-delta', text: '把底部状态圈换成圆环' };
  yield { type: 'finish', reason: { kind: 'stop' } };
};

test('模型给了完整交接单时，新会话收到的是模型写的那份', async () => {
  const { result, calls } = await run({ llm: { stream: goodStream } });
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0].request.provider, 'deepseek');
  assert.equal(calls.prepare[0].request.model, 'v4');
  assert.equal(calls.prompt.length, 1);
  const text = calls.prompt[0].content[0].text;
  assert.match(text, /【化龙妙法 · 交接单】/);
  assert.match(text, /## 目标\n把底部状态圈换成圆环/);
  assert.match(text, /整理：deepseek\/v4/);
  assert.equal(result.llm, 'deepseek/v4');
  assert.match(result.text, /交接单由 deepseek\/v4 整理/);
  assert.equal(calls.archive.length, 1);
  assert.equal(calls.rename[0].title.endsWith(' · 转世'), true);
});

test('模型失败时退回自动摘要，转世照样完成', async () => {
  const boom = async function* () {
    throw new Error('upstream 502');
  };
  const { result, calls } = await run({ llm: { stream: boom } });
  assert.equal(calls.prompt.length, 1);
  const text = calls.prompt[0].content[0].text;
  assert.match(text, /【化龙妙法 · 交接单】/);
  assert.match(text, /把底部状态圈换成圆环/);
  assert.equal(result.llm, '');
  assert.match(result.text, /自动摘要/);
  assert.match(result.text, /upstream 502/);
  assert.equal(calls.archive.length, 1);
});

test('模型收到非正常收尾也算失败，不把它当交接单', async () => {
  const cut = async function* () {
    yield { type: 'text-delta', text: '话说一半' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  };
  const { result, calls } = await run({ llm: { stream: cut } });
  assert.equal(calls.prompt.length, 1);
  assert.doesNotMatch(calls.prompt[0].content[0].text, /话说一半/);
  assert.match(result.text, /max-tokens/);
});

test('llm:false 完全不调模型，省资源但照样转世', async () => {
  const { result, calls } = await run({ llm: { stream: goodStream }, args: { llm: false } });
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.prompt.length, 1);
  assert.match(calls.prompt[0].content[0].text, /把底部状态圈换成圆环/);
  assert.match(result.text, /关掉了模型整理/);
});

test('原会话没记下用的模型时不猜，直接自动摘要', async () => {
  const home = tmp();
  const host = fakeHost({ llm: { stream: goodStream } });
  host.services.sessionController.inspect = async () => ({
    events: events.filter((event) => event.type !== 'request/header'),
    meta: {},
  });
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const result = await handoffTool(ctx).execute({ sessionId: 'parent-1' }, { signal: new AbortController().signal });
  assert.equal(host.calls.prepare.length, 0);
  assert.match(result.text, /没有记录用的模型/);
  ctx.dispose();
});

test('交接单与血缘都落盘，转世记录能查回来', async () => {
  const { calls, home, result } = await run({ llm: { stream: goodStream } });
  const rows = fs
    .readFileSync(path.join(home, 'lineage.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parent, 'parent-1');
  assert.equal(rows[0].child, 'child-1');
  assert.match(result.text, /转世完成/);
  assert.equal(calls.prompt[0].sessionId, 'child-1');
  assert.equal(calls.prompt[0].mode, 'queue');
});

test('会话还在跑就拒绝，什么都不改', async () => {
  const host = fakeHost({ llm: { stream: goodStream } });
  host.services.sessionController.list = async () => ({ items: [{ sessionId: 'parent-1', running: true }] });
  const ctx = makeContext(host.services);
  apply(ctx, { home: tmp() });
  const result = await handoffTool(ctx).execute({ sessionId: 'parent-1' }, { signal: new AbortController().signal });
  const said = typeof result === 'string' ? result : result.text;
  assert.match(said, /还在跑/);
  assert.equal(host.calls.create.length, 0);
  assert.equal(host.calls.archive.length, 0);
  ctx.dispose();
});

/** 批量转世用的假宿主：会话清单自己给，子会话 id 递增。 */
function batchHost(items) {
  const host = fakeHost();
  const calls = host.calls;
  let seq = 0;
  host.services.sessionController.list = async () => ({ items });
  host.services.sessionController.create = async (seed) => {
    calls.create.push(seed);
    seq += 1;
    return { sessionId: `child-${seq}` };
  };
  return host;
}

async function runBatch({ items, args = {} }) {
  const home = tmp();
  const host = batchHost(items);
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const tool = handoffTool(ctx);
  const result = await tool.execute({ all: true, ...args }, { signal: new AbortController().signal });
  ctx.dispose();
  return { result, text: result.text, calls: host.calls, home };
}

test('批量默认只列清单：一个会话都不动', async () => {
  const items = [
    { sessionId: 's-1', title: '会话一', running: false },
    { sessionId: 's-2', title: '会话二', running: false },
    { sessionId: 'busy', title: '还在跑', running: true },
  ];
  const { result, calls } = await runBatch({ items });
  assert.match(result.text, /可以转世 2 个会话/);
  assert.match(result.text, /s-1/);
  assert.match(result.text, /s-2/);
  assert.doesNotMatch(result.text, /busy/);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.archive.length, 0);
});

test('确认后按上限一个个转世，跑着的和当前会话都跳过', async () => {
  const items = [
    { sessionId: 's-1', title: '会话一', running: false },
    { sessionId: 's-2', title: '会话二', running: false },
    { sessionId: 's-3', title: '会话三', running: false },
    { sessionId: 'busy', title: '还在跑', running: true },
  ];
  const { result, calls } = await runBatch({ items, args: { dryRun: false, limit: 2 } });
  assert.equal(calls.create.length, 2);
  assert.equal(calls.archive.length, 2);
  assert.match(result.text, /做成 2 个/);
  assert.match(result.text, /child-1 ← s-1/);
  assert.match(result.text, /child-2 ← s-2/);
  assert.doesNotMatch(result.text, /s-3/);
});

test('批量默认不调模型整理，省 token 也省堆', async () => {
  const items = [{ sessionId: 's-1', title: '会话一', running: false }];
  const home = tmp();
  const host = batchHost(items);
  host.services.llm = {
    async prepareCall() {
      throw new Error('批量不该调模型');
    },
  };
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const result = await handoffTool(ctx).execute({ all: true, dryRun: false }, { signal: new AbortController().signal });
  assert.match(result.text, /做成 1 个/);
  assert.equal(host.calls.prepare.length, 0);
  ctx.dispose();
});

test('一个会话转世失败不影响后面的', async () => {
  const items = [
    { sessionId: 's-1', title: '会话一', running: false },
    { sessionId: 's-2', title: '会话二', running: false },
  ];
  const home = tmp();
  const host = batchHost(items);
  const realInspect = host.services.sessionController.inspect;
  host.services.sessionController.inspect = async (sessionId) => {
    if (sessionId === 's-1') throw new Error('记录读不出来');
    return realInspect(sessionId);
  };
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const result = await handoffTool(ctx).execute({ all: true, dryRun: false }, { signal: new AbortController().signal });
  assert.match(result.text, /做成 1 个，没做 1 个/);
  assert.match(result.text, /s-1：/);
  assert.match(result.text, /s-2/);
  ctx.dispose();
});

test('新会话建不起来时，失败话说清楚，不会漏出 undefined', async () => {
  const home = tmp();
  const host = fakeHost();
  host.services.sessionController.create = async () => {
    throw new Error('工作区写不进去');
  };
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const result = await handoffTool(ctx).execute({ sessionId: 'parent-1' }, { signal: new AbortController().signal });
  assert.match(result.text, /新会话没建起来/);
  assert.match(result.text, /工作区写不进去/);
  assert.match(result.text, /原会话没动/);
  assert.doesNotMatch(result.text, /undefined/);
  ctx.dispose();
});

test('批量里一个都建不起来时，每个都说清原因，不出现 undefined', async () => {
  const items = [
    { sessionId: 's-1', title: '会话一', running: false },
    { sessionId: 's-2', title: '会话二', running: false },
  ];
  const home = tmp();
  const host = batchHost(items);
  host.services.sessionController.create = async () => {
    throw new Error('工作区写不进去');
  };
  const ctx = makeContext(host.services);
  apply(ctx, { home });
  const result = await handoffTool(ctx).execute({ all: true, dryRun: false }, { signal: new AbortController().signal });
  assert.match(result.text, /做成 0 个，没做 2 个/);
  assert.doesNotMatch(result.text, /undefined/);
  ctx.dispose();
});
