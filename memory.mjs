/**
 * dsh-lifeguard → dsh-lite-memory bridge.
 *
 * 把 rules.json 里的「DSH 守护」规则压成记忆条目，写进 dsh-lite-memory 的��。
 * 纯 Node、零依赖、import 无副作用；只有显式调用 exportRules() 才会写盘。
 *
 * 设计要点（和 CONTRACT.md 对齐）：
 * - 记忆身份只看标题：`DSH崩溃防线：R001 标题`。同标题第二次导出是更新，不是新增，
 *   所以 exportRules 天然幂等。
 * - 正文是蒸馏后的原则（根因/修法/特征/防线/证据），不是原始日志；≤600 字。
 * - 写之前把目标层的 state.json 备份成 state.json.bak-crashlore-<ts>；
 *   dryRun 不创建目录、不写任何文件、不建锁。
 * - 测试/宿主要指向别处：传 opts.storeDir 或 opts.home（等价 DSH_HOME），
 *   本模块不读也不改 process.env。
 *
 * Host 内调用（index.js）：
 *   dsh-lite-memory 是 tools 插件（`export const inject = ['tools']`），没有
 *   `ctx.memory` 服务，所以没有 `inject: ['memory']` 可用。Host 内直接用本模块：
 *     import { exportRules, memoryStatus } from './memory.mjs';
 *     await exportRules(rules, { home });        // 与 import 同一进程、同一模块实例
 *   若一定要走工具面，则是 ctx.tools 里已注册的 `memory_save`（见 lite-memory
 *   index.js 的 SAVE_PARAMS）；本模块不依赖它的 execute 形状（需要完整 exec 令牌，
 *   跨插件构造不可靠），直接调 store.js 的 upsert 是稳定路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL as nodePathToFileURL } from 'node:url';

export const DEFAULT_TITLE_PREFIX = 'DSH崩溃防线：';
export const DEFAULT_WHEN = '写或改 DSH 插件、配置时';
export const DEFAULT_TAGS = ['lifeguard'];
export const BODY_MAX = 600;
const DEFAULT_SCOPE = 'global';
export const MEMORY_PACKAGE = 'dsh-lite-memory';

const TITLE_CHARS = 60;
const SUMMARY_CHARS = 60;
const WHEN_CHARS = 60;
const TAG_CHARS = 20;
const MAX_TAGS = 5;

function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function defaultProfileDir() {
  return process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

/** 目标存储目录：显式 storeDir 优先，其次 <home>/lite-memory（lite-memory 的默认根）。 */
export function memoryStoreDir(options = {}) {
  if (options.storeDir) return path.resolve(options.storeDir);
  return path.join(path.resolve(options.home || defaultHome()), 'lite-memory');
}

/** 无损截断（不切代理对），超长时尽量在分隔符处收尾。 */
function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
}

function dateOnly(iso) {
  const text = String(iso ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/**
 * 找 dsh-lite-memory 的安装目录（要能直接 import 其中的 store.js）。
 * 顺序：显式 liteMemoryDir → DSH_LITE_MEMORY_DIR → profile 里 resolve 包 →
 *       本仓库同级目录 → 当前进程 resolve。找不到返回 null，不抛。
 */
export function resolveLiteMemoryDir(options = {}) {
  const candidates = [];
  const push = (dir) => {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  };
  push(options.liteMemoryDir);
  push(process.env.DSH_LITE_MEMORY_DIR);
  const profileDir = path.resolve(options.profileDir || defaultProfileDir());
  try {
    const req = createRequire(path.join(profileDir, 'package.json'));
    const hit = req.resolve(MEMORY_PACKAGE);
    push(path.dirname(hit));
  } catch {
    /* profile 里没装：继续找 */
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    push(path.join(path.dirname(here), '..', MEMORY_PACKAGE));
  } catch {
    /* ignore */
  }
  try {
    const req = createRequire(import.meta.url);
    push(path.dirname(req.resolve(MEMORY_PACKAGE)));
  } catch {
    /* ignore */
  }
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === MEMORY_PACKAGE && fs.existsSync(path.join(dir, 'store.js'))) return fs.realpathSync(dir);
    } catch {
      /* 不是安装目录 */
    }
  }
  return null;
}

/** 按 scope 选项构造 lite-memory 的 layer 对象；项目层沿用 state.scopeOf 的命名，再把目录挪到 storeDir 下。 */
export function memoryScope(state, options = {}) {
  const storeDir = memoryStoreDir(options);
  if (options.scope === 'global') {
    return { key: 'global', dir: path.join(storeDir, 'global'), cwd: '', rootSource: 'global', confirmed: true };
  }
  const projectDir = path.resolve(options.projectDir || process.cwd());
  let base = null;
  try {
    base = state.scopeOf(projectDir);
  } catch {
    base = null;
  }
  const key = base?.key || `${path.basename(projectDir).replace(/[^\w.-]+/g, '-').slice(0, 32) || 'project'}-${shortHash(projectDir)}`;
  return { ...(base || {}), key, dir: path.join(storeDir, key), cwd: base?.cwd || projectDir, confirmed: true };
}

function shortHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 记忆状态：可用性、存储目录、当前活跃条数。
 * 只读（不建目录、不加锁）；传入 home/storeDir 时不会碰真实 ~/.dsh。
 */
export function memoryStatus(options = {}) {
  if (typeof options === 'string') options = { home: options };
  const storeDir = memoryStoreDir(options);
  const moduleDir = resolveLiteMemoryDir(options);
  const result = { available: false, reason: 'store_missing', storeDir, count: 0, layers: [], moduleDir, packageVersion: '' };
  if (moduleDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
      result.packageVersion = String(pkg.version || '');
    } catch {
      /* ignore */
    }
  }
  if (!fs.existsSync(storeDir)) return result;
  let layers = [];
  try {
    layers = fs.readdirSync(storeDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return result;
  }
  let count = 0;
  const detail = [];
  for (const name of layers) {
    const file = path.join(storeDir, name, 'state.json');
    let entries = [];
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries = Array.isArray(doc?.payload?.entries) ? doc.payload.entries : Array.isArray(doc?.entries) ? doc.entries : [];
    } catch {
      continue;
    }
    const active = entries.filter((entry) => entry?.status === 'active').length;
    count += active;
    detail.push({ key: name, entries: active });
  }
  result.layers = detail;
  result.count = count;
  if (!moduleDir) {
    result.reason = 'module_missing';
    result.available = false;
    return result;
  }
  result.available = true;
  result.reason = 'ok';
  return result;
}

/** 稳定标题：前缀 + 规则号 + 标题；超限时只缩短标题部分，前缀和规则号保持稳定。 */
export function memoryTitleFor(rule, options = {}) {
  const prefix = String(options.titlePrefix ?? DEFAULT_TITLE_PREFIX);
  const id = String(rule?.id ?? '').trim();
  const title = String(rule?.title ?? '').replace(/\s+/g, ' ').trim();
  const head = `${prefix}${id}${id ? ' ' : ''}`;
  const room = Math.max(1, TITLE_CHARS - head.length);
  return head.length >= TITLE_CHARS ? clip(head, TITLE_CHARS) : head + clip(title, room);
}

/** 蒸馏正文：根因 / 修法 / 特征 / 防线 / 证据五段，≤600 字，不抄日志。 */
export function buildMemoryBody(rule) {
  const parts = [];
  const cause = clip(rule?.cause, 120);
  const fix = clip(rule?.fix, 120);
  if (cause) parts.push(`根因：${cause}`);
  if (fix) parts.push(`修法：${fix}`);
  const signature = clip(rule?.signature, 160);
  if (signature) parts.push(`特征：${signature}`);
  const guard = rule?.guard;
  if (guard && (guard.kind || guard.message)) {
    const kind = clip(guard.kind, 20);
    const message = clip(guard.message, 120);
    const pattern = clip(guard.pattern, 80);
    const head = [kind ? `${kind} 检查` : '检查', message].filter(Boolean).join('：');
    parts.push(`防线：${head}${pattern ? `（${pattern}）` : ''}`);
  }
  const hits = Number(rule?.hits ?? 0);
  const last = dateOnly(rule?.lastSeen);
  const severity = clip(rule?.severity, 10);
  const evidence = [hits ? `本机命中 ${hits} 次` : '', last ? `最近 ${last}` : '', severity ? `级别 ${severity}` : ''].filter(Boolean).join('，');
  if (evidence) parts.push(`证据：${evidence}`);
  return clip(parts.join('\n'), BODY_MAX);
}

/** 单条规则 → memory_save 同形草稿（不写盘）。 */
export function buildMemoryDraft(rule, options = {}) {
  const title = memoryTitleFor(rule, options);
  const summarySource = clip(rule?.title, SUMMARY_CHARS);
  const tags = [...new Set([...(options.tags || DEFAULT_TAGS), clippedTags(rule?.tags)])]
    .map((tag) => clip(tag, TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  return {
    title,
    summary: summarySource,
    when: clip(options.when ?? DEFAULT_WHEN, WHEN_CHARS),
    body: buildMemoryBody(rule),
    kind: 'pitfall',
    memoryClass: 'project_fact',
    durability: 'durable',
    tags,
    origin: 'model_drafted',
    ruleId: String(rule?.id ?? ''),
  };
}

function clippedTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => String(tag ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2);
}

async function loadStore(options = {}) {
  const moduleDir = resolveLiteMemoryDir(options);
  if (!moduleDir) {
    const error = new Error(`没有找到 ${MEMORY_PACKAGE} 安装目录；可用 DSH_LITE_MEMORY_DIR / opts.liteMemoryDir 指定`);
    error.code = 'MODULE_MISSING';
    throw error;
  }
  const state = await import(nodePathToFileURL(path.join(moduleDir, 'state.js')).href);
  const store = await import(nodePathToFileURL(path.join(moduleDir, 'store.js')).href);
  return { moduleDir, state, store };
}

/** 写前备份目标层的 state.json（同一次导出只备一次；不删旧备份）。 */
function backupLayer(layer, stamp) {
  const file = path.join(layer.dir, 'state.json');
  if (!fs.existsSync(file)) return null;
  const backup = path.join(layer.dir, `state.json.bak-crashlore-${stamp}`);
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  return backup;
}

function normalizeRules(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rules)) return input.rules;
  return [];
}

/**
 * 导出规则到 dsh-lite-memory。
 * @param {Array|object} rules - rules 数组或 rules.json 文档
 * @param {object} [options] - { dryRun, scope, home, storeDir, projectDir, liteMemoryDir, titlePrefix, when, tags, backup }
 * @returns {Promise<{exported: Array, skipped: Array, storeDir: string, scope: string, dryRun: boolean, backup: string|null}>}
 */
export async function exportRules(rules, options = {}) {
  const opts = { ...options };
  opts.scope = opts.scope === 'global' ? 'global' : 'project';
  const list = normalizeRules(rules);
  const dryRun = opts.dryRun === true;
  const out = { exported: [], skipped: [], storeDir: memoryStoreDir(opts), scope: opts.scope, dryRun, backup: null };

  let loaded;
  try {
    loaded = await loadStore(opts);
  } catch (error) {
    for (const rule of list) out.skipped.push({ ruleId: String(rule?.id ?? ''), reason: 'module_missing', detail: String(error.message || error) });
    out.reason = 'module_missing';
    return out;
  }
  const { state, store } = loaded;
  /* Crash lore is machine-wide: default to the global layer so it is recalled from any project. */
  const layer = memoryScope(state, { ...opts, scope: opts.scope ?? DEFAULT_SCOPE });

  if (!dryRun) {
    try {
      fs.mkdirSync(layer.dir, { recursive: true });
    } catch (error) {
      for (const rule of list) out.skipped.push({ ruleId: String(rule?.id ?? ''), reason: 'store_unwritable', detail: String(error.message || error) });
      out.reason = 'store_unwritable';
      return out;
    }
  }

  let existing = new Map();
  try {
    const index = store.loadIndex(layer, { readOnly: true });
    existing = new Map((index.entries || []).map((entry) => [String(entry.title || '').trim(), entry]));
  } catch {
    existing = new Map();
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  if (!dryRun && opts.backup !== false) out.backup = backupLayer(layer, stamp);

  for (const rule of list) {
    const ruleId = String(rule?.id ?? '').trim();
    if (!rule || typeof rule !== 'object') {
      out.skipped.push({ ruleId, reason: 'invalid_rule' });
      continue;
    }
    if (!String(rule.title ?? '').trim()) {
      out.skipped.push({ ruleId, reason: 'empty_title' });
      continue;
    }
    const draft = buildMemoryDraft(rule, opts);
    const field = { ruleId, memoryTitle: draft.title };
    const known = existing.get(draft.title);
    if (dryRun) {
      out.exported.push({ ...field, action: known ? (known.body === draft.body ? 'unchanged' : 'update') : 'create', memoryId: known?.id || null, planned: true });
      continue;
    }
    try {
      let result = store.upsert(layer, draft);
      /* Near-duplicate titles inside one batch (R007 vs R019 …) are genuinely distinct rules:
       * only when the collision is with our own lore entries do we force a distinct insert. */
      if (result?.needsResolution && isOwnEntry(result, opts)) {
        result = store.upsert(layer, { ...draft, resolution: 'distinct' });
      }
      if (result?.needsResolution) {
        out.skipped.push({ ...field, reason: 'needs_resolution', detail: (result.similarList || []).map((row) => row.title).join(' / ') });
        continue;
      }
      const record = result?.record;
      const action = !record ? 'unchanged' : result.noop ? 'unchanged' : result.merged ? 'update' : 'create';
      out.exported.push({ ...field, action, memoryId: record?.id || null, revision: record?.revision ?? null });
      existing.set(draft.title, { id: record?.id, title: draft.title, body: draft.body });
    } catch (error) {
      const reason = error?.code === 'unsafe' || /疑似凭据/.test(String(error?.message)) ? 'unsafe' : 'write_failed';
      out.skipped.push({ ...field, reason, detail: String(error?.message || error).slice(0, 200) });
    }
  }
  out.count = memoryStatus(opts).count;
  return out;
}

function isOwnEntry(result, opts) {
  const prefix = opts.titlePrefix ?? DEFAULT_TITLE_PREFIX;
  const titles = (result.similarList || []).map((row) => String(row.title || ''));
  return titles.length > 0 && titles.every((title) => title.startsWith(prefix));
}

/** cli.mjs `export --md` 用：紧凑 Markdown 块，不碰记忆库。 */
export function exportMarkdown(rules, options = {}) {
  const list = normalizeRules(rules);
  const title = clip(options.title ?? 'DSH 守护（本机日志沉淀）', 80);
  if (!list.length) return `## ${title}\n\n（暂无规则）\n`;
  const lines = [`## ${title}`, ''];
  for (const rule of list) {
    const severity = clip(rule?.severity, 10);
    lines.push(`- **${clip(rule?.title, 60)}**${severity ? `（${severity}）` : ''}`);
    if (rule?.cause) lines.push(`  - 根因：${clip(rule.cause, 120)}`);
    if (rule?.fix) lines.push(`  - 修法：${clip(rule.fix, 120)}`);
    if (rule?.guard?.message) lines.push(`  - 防线：${clip(rule.guard.message, 120)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 唯一安全的手抄路径：只产出草稿文件内容，不写任何存储。 */
export function toMemoryDraft(rules, options = {}) {
  const list = normalizeRules(rules);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    storeDir: memoryStoreDir(options),
    scope: options.scope === 'global' ? 'global' : 'project',
    drafts: list.map((rule) => buildMemoryDraft(rule, options)),
  };
}
