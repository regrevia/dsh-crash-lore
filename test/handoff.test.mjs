import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRIEF_MAX,
  appendLineage,
  buildBrief,
  clip,
  collectFacts,
  deriveTitle,
  filesIn,
  generationOf,
  lineageChain,
  messageText,
  readLineage,
  toolSummary,
} from '../handoff.mjs';

const events = [
  { type: 'turn/start', time: 1, data: { turn: 1 } },
  { type: 'user/message', time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: '把底部状态圈换成圆环' }] } } },
  { type: 'assistant/message', time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '改 /Users/apple/Desktop/DSH/dsh-crash-lore/client.js 的注册位置' }, { type: 'image', data: 'x' }] } } },
  { type: 'tool/call', time: 4, data: { name: 'read' } },
  { type: 'tool/call', time: 5, data: { name: 'read' } },
  { type: 'tool/call', time: 6, data: { name: 'bash' } },
  { type: 'turn/start', time: 7, data: { turn: 2 } },
  { type: 'user/message', time: 8, data: { message: { role: 'user', content: [{ type: 'text', text: '顺便把 85% 变红也加上\n第二行不要' }] } } },
];

test('messageText 只取文字块，图片块跳过', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }] }), 'a');
  assert.equal(messageText({ content: [] }), '');
  assert.equal(messageText(undefined), '');
});

test('clip 有上限且超长带省略号', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('  x  ', 5), 'x');
});

test('collectFacts 取人话、进展、工具与轮次', () => {
  const facts = collectFacts(events);
  assert.equal(facts.turns, 2);
  assert.equal(facts.userTexts.length, 2);
  assert.equal(facts.assistantTexts.length, 1);
  assert.deepEqual(facts.tools, ['read', 'read', 'bash']);
  assert.equal(facts.lastTime, 8);
  assert.deepEqual(collectFacts(null), { turns: 0, userTexts: [], assistantTexts: [], tools: [], lastTime: 0 });
});

test('toolSummary 按次数排序并限量', () => {
  assert.deepEqual(toolSummary(['read', 'read', 'bash']), ['read×2', 'bash×1']);
  assert.equal(toolSummary(['a', 'b', 'c'], 2).length, 2);
});

test('filesIn 去重并只留最近几个', () => {
  const files = filesIn(['/a/b.mjs and /a/b.mjs', '/c/d.json'], 10);
  assert.deepEqual(files, ['/a/b.mjs', '/c/d.json']);
  assert.equal(filesIn(['/a/b.mjs', '/c/d.json'], 1).length, 1);
});

test('buildBrief 有来源、重点段落，且总长封顶', () => {
  const brief = buildBrief({ parentId: 'session-old', parentTitle: '状态圈', events, limit: 400 });
  assert.ok(brief.text.length <= 400);
  assert.ok(brief.text.includes('【化龙妙法 · 交接单】'));
  assert.ok(brief.text.includes('session-old'));
  assert.ok(brief.text.includes('只回复「收到」'));
  const full = buildBrief({ parentId: 'session-old', parentTitle: '状态圈', events });
  assert.ok(full.text.length <= BRIEF_MAX);
  assert.ok(full.text.includes('dsh-crash-lore/client.js'));
  assert.ok(full.text.includes('read×2'));
  assert.equal(full.title, '状态圈');
});

test('buildBrief 空会话不炸，标题走兜底', () => {
  const brief = buildBrief({ parentId: 'session-empty', events: [] });
  assert.equal(brief.title, '未命名会话');
  assert.ok(brief.text.includes('没有留下文字需求'));
});

test('deriveTitle 取最近一条人话的首行', () => {
  const facts = collectFacts(events);
  assert.equal(deriveTitle(facts), '顺便把 85% 变红也加上');
});

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crash-lore-handoff-'));

test('appendLineage 落盘、可读、坏行跳过', () => {
  const home = tmpHome();
  try {
    appendLineage(home, { child: 'b', parent: 'a', generation: 1, at: 1, title: 't' });
    fs.appendFileSync(path.join(home, 'lineage.jsonl'), '{坏行\n');
    appendLineage(home, { child: 'c', parent: 'b', generation: 2, at: 2, title: 't2' });
    const rows = readLineage(home);
    assert.deepEqual(rows.map((row) => row.child), ['b', 'c']);
    assert.equal(fs.existsSync(path.join(home, 'lineage.jsonl.tmp')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readLineage 没有文件时是空数组', () => {
  const home = tmpHome();
  try {
    assert.deepEqual(readLineage(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('generationOf 支持转世的转世', () => {
  const rows = [
    { child: 'g1', parent: 'orig', generation: 1 },
    { child: 'g2', parent: 'g1', generation: 2 },
  ];
  assert.equal(generationOf(rows, 'orig'), 1);
  assert.equal(generationOf(rows, 'g1'), 2);
  assert.equal(generationOf(rows, 'g2'), 3);
});

test('lineageChain 从远到近，含环时不死循环', () => {
  const rows = [
    { child: 'g1', parent: 'orig', generation: 1, title: '一' },
    { child: 'g2', parent: 'g1', generation: 2, title: '二' },
  ];
  assert.deepEqual(lineageChain(rows, 'g2').map((row) => row.child), ['g1', 'g2']);
  assert.equal(lineageChain([{ child: 'x', parent: 'y', generation: 1 }, { child: 'y', parent: 'x', generation: 2 }], 'x').length, 2);
});
