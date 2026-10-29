/**
 * 化龙妙法：把一个大会话转世成新会话。
 *
 * 这里只做纯计算和落盘，不碰宿主服务：交接单从会话事件里**确定性**地取，不调用模型、
 * 不恢复旧会话（恢复旧会话本身就要吃几 GB 堆，和转世的目的相反）。所有结果长度封顶，
 * 转世次数与血缘记录也有上限，避免这个功能自己成为新的内存来源。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BRIEF_MAX = 6000;
export const LINEAGE_MAX_ROWS = 2000;
const LINEAGE_FILE = 'lineage.jsonl';
const HANDOFF_DIR = 'handoff';

/** ContentBlock 里只有带 text 的块对交接单有用；图片、工具调用块直接跳过。 */
export function blockText(block) {
  return typeof block?.text === 'string' ? block.text : '';
}

/** 一条消息压缩成一行文字；多块用换行连，空消息返回空串。 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.map(blockText).filter(Boolean).join('\n');
}

export function clip(text, limit) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (limit <= 0) return '';
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * 从会话事件里取交接单要用的原料：最近的人话、最近的进展、最近的工具、轮次数。
 * 只读，不改变任何东西；事件再多也只保留尾部片段。
 */
export function collectFacts(events) {
  const facts = { turns: 0, userTexts: [], assistantTexts: [], tools: [], lastTime: 0 };
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    if (typeof event.time === 'number' && event.time > facts.lastTime) facts.lastTime = event.time;
    const data = event.data;
    if (!data || typeof data !== 'object') continue;
    if (event.type === 'turn/start') facts.turns += 1;
    else if (event.type === 'user/message') {
      const text = messageText(data.message);
      if (text) facts.userTexts.push(text);
    } else if (event.type === 'assistant/message') {
      const text = messageText(data.message);
      if (text) facts.assistantTexts.push(text);
    } else if (event.type === 'tool/call' && typeof data.name === 'string') {
      facts.tools.push(data.name);
    }
  }
  return facts;
}

/** 工具调用按出现次数排，同频按最近一次靠前；只留前 limit 个。 */
export function toolSummary(tools, limit = 10) {
  const order = new Map();
  const counts = new Map();
  for (const [index, name] of (Array.isArray(tools) ? tools : []).entries()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    order.set(name, index);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order.get(b[0]) - order.get(a[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`);
}

/** 从文字里找绝对路径；只收像文件的，去重后按最近出现排序。 */
export function filesIn(texts, limit = 12) {
  const seen = new Set();
  const hits = [];
  /* 长的后缀排前面：js 放在 json/jsonl 之后，否则 /a.json 会被截成 /a.js。 */
  const pattern = /\/[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:jsonl|json|mjs|cjs|tsx|jsx|yml|yaml|html|toml|mjs|cjs|ts|js|md|py|sh|css)/g;
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string') continue;
    for (const match of text.match(pattern) ?? []) {
      if (seen.has(match)) continue;
      seen.add(match);
      hits.push(match);
    }
  }
  return hits.slice(-limit);
}

/** 标题不好从事件里拿，用最近一条人话的第一行兜底。 */
export function deriveTitle(facts, fallback = '未命名会话') {
  const last = facts?.userTexts?.length ? facts.userTexts[facts.userTexts.length - 1] : '';
  const line = String(last).split('\n').map((row) => row.trim()).find(Boolean);
  const title = clip(line ?? '', 24);
  return title || fallback;
}

/**
 * 交接单：写给接手的新会话看。顺序按「要干什么 → 做到哪 → 动过什么 → 原文在哪」，
 * 尾部固定一句让新会话先停下等指令，避免转世当场又开一个重活。
 */
export function buildBrief({ parentId, parentTitle, events, limit = BRIEF_MAX }) {
  const facts = collectFacts(events);
  const title = clip(parentTitle, 40) || deriveTitle(facts);
  const todo = facts.userTexts.slice(-3).map((text, index, all) => `${index === all.length - 1 ? '最近' : '之前'}：${clip(text, 300)}`);
  const progress = facts.assistantTexts.slice(-4).map((text) => `- ${clip(text, 400)}`);
  const tools = toolSummary(facts.tools);
  const files = filesIn([...facts.assistantTexts, ...facts.userTexts]);
  const lines = [
    '【化龙妙法 · 交接单】',
    `来源会话：${parentId}（${title}）`,
    `轮次：${facts.turns}`,
    '',
    '## 要做什么',
    ...(todo.length ? todo : ['（原会话里没有留下文字需求）']),
    '',
    '## 已经做到哪',
    ...(progress.length ? progress : ['（没有可继承的文字进展）']),
    '',
    '## 最近动过',
    tools.length ? tools.join('、') : '（没有工具调用记录）',
    '',
    '## 涉及文件',
    ...(files.length ? files.map((file) => `- ${file}`) : ['（没有识别到文件路径）']),
    '',
    '## 原文',
    `原会话已归档，需要细节时取消归档回看（${parentId}），不要重读整段历史。`,
    '',
    '这条消息只是交接单：先只回复「收到」，不要调用工具，等用户下一步指令。',
  ];
  const text = lines.join('\n');
  return { text: clip(text, limit), facts, title };
}

export function lineagePath(home) {
  return path.join(home, LINEAGE_FILE);
}

/** 读血缘；坏行跳过而不是让整个文件作废。 */
export function readLineage(home) {
  try {
    const raw = fs.readFileSync(lineagePath(home), 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const row = JSON.parse(text);
        if (row && typeof row.child === 'string') rows.push(row);
      } catch {
        /* 单行坏了不影响别的记录 */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** 追加一条血缘；超过上限时只留最近的，用临时文件换名，写一半也不会留下半个文件。 */
export function appendLineage(home, row) {
  const file = lineagePath(home);
  const rows = [...readLineage(home), row].slice(-LINEAGE_MAX_ROWS);
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  fs.renameSync(tmp, file);
  return rows.length;
}

/**
 * 本会话是第几代：父会话若是别人转世的子会话，就接着往上数。
 * 血缘只在插件自己的记录里，不依赖会话标题（标题随时会被用户改）。
 */
export function generationOf(rows, parentId) {
  const byChild = new Map();
  for (const row of Array.isArray(rows) ? rows : []) byChild.set(row.child, row);
  let generation = 1;
  let cursor = parentId;
  const seen = new Set();
  while (cursor && byChild.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    generation = Math.max(generation, Number(byChild.get(cursor).generation ?? 0) + 1);
    cursor = byChild.get(cursor).parent;
  }
  return generation;
}

/** 一条链：祖先从远到近，最后是本会话。用于「转世的转世怎么办」的追问。 */
export function lineageChain(rows, sessionId) {
  const byChild = new Map();
  for (const row of Array.isArray(rows) ? rows : []) byChild.set(row.child, row);
  const chain = [];
  let cursor = sessionId;
  const seen = new Set();
  while (cursor && byChild.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byChild.get(cursor);
    chain.unshift({ child: row.child, parent: row.parent, generation: row.generation, title: row.title });
    cursor = row.parent;
  }
  return chain;
}
