import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mem from '../memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LITE_DIR = mem.resolveLiteMemoryDir();
const skip = LITE_DIR ? false : '没有找到 dsh-lite-memory 安装目录';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-memory-'));
}

function rule(overrides = {}) {
  return {
    id: 'R001',
    title: 'client.js 顶层禁止重新声明同名字符串',
    signature: 'Identifier .* has already been declared',
    cause: 'client.js 被热重载重复执行，顶层 let 重声明',
    fix: '顶层只用 var，或整块包进函数',
    guard: { kind: 'source-regex', pattern: '^(let|const) ', message: 'client.js 顶层不要用 let/const' },
    severity: 'fatal',
    tags: ['client'],
    hits: 3,
    firstSeen: '2025-10-01T00:00:00.000Z',
    lastSeen: '2025-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function activeEntries(storeDir) {
  const rows = [];
  if (!fs.existsSync(storeDir)) return rows;
  for (const layer of fs.readdirSync(storeDir)) {
    const file = path.join(storeDir, layer, 'state.json');
    if (!fs.existsSync(file)) continue;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of doc.payload?.entries || []) if (entry.status === 'active') rows.push({ layer, entry });
  }
  return rows;
}

test('memoryStatus: 没有存储目录时不可用，且不创建任何东西', () => {
  const home = tempHome();
  const status = mem.memoryStatus({ home });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'store_missing');
  assert.equal(status.count, 0);
  assert.equal(status.storeDir, path.join(home, 'lite-memory'));
  assert.equal(fs.existsSync(path.join(home, 'lite-memory')), false);
});

test('dryRun 完全无副作用：不建目录、不写 state.json', { skip }, async () => {
  const home = tempHome();
  const result = await mem.exportRules([rule()], { home, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.exported.length, 1);
  assert.equal(result.exported[0].action, 'create');
  assert.equal(fs.existsSync(path.join(home, 'lite-memory')), false);
});

test('exportRules 导出后可按标题幂等更新，不产生重复条目', { skip }, async () => {
  const home = tempHome();
  const first = await mem.exportRules([rule()], { home, projectDir: home });
  assert.equal(first.exported.length, 1);
  assert.equal(first.exported[0].action, 'create');
  assert.match(first.exported[0].memoryTitle, /^DSH崩溃防线：R001 /);
  const second = await mem.exportRules([rule()], { home, projectDir: home });
  assert.equal(second.exported[0].action, 'unchanged');
  assert.equal(second.exported[0].memoryId, first.exported[0].memoryId);
  const rows = activeEntries(first.storeDir);
  assert.equal(rows.length, 1);
  const entry = rows[0].entry;
  assert.equal(entry.revision, 1);
  const body = entry.current.body;
  assert.ok(body.length <= mem.BODY_MAX, `正文 ${body.length} 字超限`);
  for (const word of ['根因', '修法', '特征', '防线', '证据']) assert.ok(body.includes(word), `正文缺 ${word}`);
});

test('改过的正文再次导出会更新同一条记忆', { skip }, async () => {
  const home = tempHome();
  await mem.exportRules([rule()], { home, projectDir: home });
  const changed = await mem.exportRules([rule({ fix: '顶层只用 var，并加 source-regex 守卫' })], { home, projectDir: home });
  assert.equal(changed.exported[0].action, 'update');
  const rows = activeEntries(changed.storeDir);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].entry.current.body.includes('source-regex 守卫'));
});

test('真跑会先备份 state.json，备份文件名带 crashlore 时间戳', { skip }, async () => {
  const home = tempHome();
  await mem.exportRules([rule()], { home, projectDir: home });
  const second = await mem.exportRules([rule({ fix: '换一种修法' })], { home, projectDir: home });
  assert.ok(second.backup, '第二次导出应该产生备份');
  assert.match(path.basename(second.backup), /^state\.json\.bak-crashlore-\d{8}T\d{6}$/);
  assert.equal(fs.existsSync(second.backup), true);
});

test('scope=global 写进 global 层', { skip }, async () => {
  const home = tempHome();
  const result = await mem.exportRules([rule()], { home, scope: 'global' });
  assert.equal(result.scope, 'global');
  assert.equal(result.exported.length, 1);
  assert.equal(fs.existsSync(path.join(result.storeDir, 'global', 'state.json')), true);
});

test('坏规则进 skipped：空标题、疑似凭据、近似标题需人工判定', { skip }, async () => {
  const home = tempHome();
  const result = await mem.exportRules(
    [
      rule({ id: 'R002', title: '' }),
      rule({ id: 'R003', title: '疑似泄露', cause: 'token: abcdef123456' }),
      rule({ id: 'R004', title: 'Host 启动顺序与视图挂载' }),
      rule({ id: 'R004', title: 'Host 启动顺序与视图挂载顺序' }),
    ],
    { home, projectDir: home },
  );
  const reasons = result.skipped.map((item) => item.reason);
  assert.ok(reasons.includes('empty_title'));
  assert.ok(reasons.includes('unsafe'));
  /* R004 vs R004 are two of our own rules with similar Chinese titles: they are distinct rules,
   * so the second one is force-inserted instead of being parked for manual resolution. */
  const r4 = result.exported.filter((item) => item.ruleId === 'R004');
  assert.equal(r4.length, 2, `exported: ${JSON.stringify(result.exported)}`);
  assert.ok(r4.some((item) => item.action === 'create'));
  const titles = new Set(r4.map((item) => item.memoryTitle));
  assert.equal(titles.size, 2);
});

test('titlePrefix 可定制，且标题不超过 60 字', { skip }, async () => {
  const home = tempHome();
  const longTitle = '一个非常长的崩溃标题'.repeat(12);
  const result = await mem.exportRules([rule({ id: 'R009', title: longTitle })], { home, projectDir: home, titlePrefix: '本机坑：' });
  const title = result.exported[0].memoryTitle;
  assert.ok(title.startsWith('本机坑：R009 '), title);
  assert.ok(title.length <= 60, `标题 ${title.length} 字`);
});

test('exportMarkdown / toMemoryDraft 都不写存储', async () => {
  const home = tempHome();
  const md = mem.exportMarkdown([rule()]);
  assert.match(md, /## DSH 守护/);
  assert.match(md, /client\.js 顶层禁止重新声明/);
  const draftDocument = mem.toMemoryDraft([rule()], { home });
  assert.equal(draftDocument.drafts.length, 1);
  assert.match(draftDocument.drafts[0].title, /^DSH崩溃防线：R001 /);
  assert.equal(fs.existsSync(path.join(home, 'lite-memory')), false);
});

test('导到临时 home 不会动真实 ~/.dsh 存储', { skip }, async () => {
  const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const before = mem.memoryStatus({ home: realHome }).count;
  const home = tempHome();
  await mem.exportRules([rule()], { home, projectDir: home });
  const after = mem.memoryStatus({ home: realHome }).count;
  assert.equal(after, before);
});
