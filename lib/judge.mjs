/**
 * One judgement of "does this text crash the host at activation", shared by the live
 * write guard (defense.mjs) and the CLI check (cli.mjs), so a denial and a CLI finding
 * read the same rule id, reason and fix. Pure Node, zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { topLevelThrow } from '../guard.mjs';

const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/;
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
/* Content the loader never executes. Judged on the path *relative to the plugin root*, so a
 * plugin that merely sits under a directory called tools/, bin/ or test/ is still live. */
const NON_ACTIVATION = /^(?:scripts?|bin|tools|test|tests|__tests__|docs?|examples?)(?:[/\\]|$)/;

/** Truncated text for a denial: one line, never a whole file dump. */
function snippetFor(text, line) {
  const raw = String(text).split('\n')[line - 1] ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/** Fallback relative path when the caller has no plugin root: keep the immediate parent. */
function fallbackRel(file) {
  const base = path.basename(String(file ?? ''));
  const parent = path.basename(path.dirname(path.resolve(String(file ?? '.'))));
  return parent && parent !== '.' ? `${parent}/${base}` : base;
}

export function lineOf(text, index) {
  return String(text).slice(0, Math.max(0, index)).split('\n').length;
}

function readTextSafe(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 'module' when the nearest package.json declares ESM, 'commonjs' when it says so. */
function nearestPackageType(file) {
  let dir = path.dirname(path.resolve(String(file ?? '.')));
  for (let depth = 0; depth < 6; depth += 1) {
    const pkg = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (parsed && typeof parsed.type === 'string') return parsed.type;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * Blank comments and string/template literals, keeping every newline and every offset, so
 * pattern checks look at code only: a comment or a message that merely mentions a banned
 * call is not a call. Regex literals are left alone on purpose (their text is escaped).
 */
export function maskCode(text, options = {}) {
  const keepStrings = options.keepStrings === true;
  const source = String(text ?? '');
  const out = source.split('');
  const blank = (at) => {
    if (at >= 0 && at < out.length && out[at] !== '\n') out[at] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i++);
      blank(i++);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (keepStrings) {
        i += 1;
        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          const closing = source[i] === ch;
          i += 1;
          if (closing) break;
        }
        continue;
      }
      const quote = ch;
      blank(i++);
      while (i < source.length) {
        if (source[i] === '\\') {
          blank(i++);
          blank(i++);
          continue;
        }
        const closing = source[i] === quote;
        blank(i++);
        if (closing) break;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Top-level `await` (statement or initializer position) never settles the plugin's activation. */
function topLevelAwait(masked) {
  const lines = masked.split('\n');
  let depth = 0;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    if (depth === 0) {
      const statement = /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*await\b|^\s*(?:export\s+)?await\b/.test(line);
      const notInFunction = !/=>/.test(line) && !/for\s+await\b/.test(line) && !/\bfunction\b/.test(line);
      if (statement && notInFunction) return { line: at + 1 };
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

const SECRET = /(?:api[_-]?key|token|secret|password)\s*:\s*["']?[A-Za-z0-9_\-]{16,}/i;

function judgeOne(options) {
  const { ruleId, title, severity = 'boot', line = 0, message, fix, snippet = '', text } = options;
  return { ruleId, title, severity, line, message, fix, snippet: snippet || snippetFor(text, line) };
}

/** Duplicate patch ids: the later row silently replaces the earlier one and the bundle loads half-applied. */
function duplicatePatchId(text) {
  const seen = new Map();
  const lines = String(text).split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const match = /^\s*-?\s*id:\s*["']?([A-Za-z0-9_.:@-]+)/.exec(lines[at]);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) return { id, line: at + 1, first: seen.get(id) };
    seen.set(id, at + 1);
  }
  return null;
}

/**
 * The single text-level judgement. Returns a finding shaped like the preflight findings
 * (`{ruleId,title,severity,line,message,fix,snippet}`) or null when the text is fine.
 * @param {string} text
 * @param {string} file path used for ESM/type detection and for the fallback label
 * @param {{rel?: string}} [options] path relative to the plugin root; when absent the
 *   immediate parent directory name is used, which keeps `.../tools/x.mjs` out of scope
 *   without letting an ancestor of the plugin root disable inspection.
 */
export function inspectText(text, file, options = {}) {
  if (typeof text !== 'string' || !text) return null;
  const filePath = String(file ?? '');
  const rel = String(options.rel || fallbackRel(filePath)).replace(/\\/g, '/').replace(/^\.\//, '');
  if (NON_ACTIVATION.test(rel)) return null;
  const masked = maskCode(text);

  if (CODE.test(rel)) {
    const top = topLevelThrow(masked);
    if (top) {
      return judgeOne({
        ruleId: 'P014',
        title: '模块顶层有 throw',
        line: top.line,
        message: `${rel}:${top.line} 顶层直接 throw，模块加载即抛错，整个 profile 激活失败。`,
        fix: '把 throw 挪进 apply()/activate()，或改成记录日志后正常返回',
        text,
      });
    }

    const awaited = topLevelAwait(masked);
    if (awaited) {
      return judgeOne({
        ruleId: 'P015',
        title: '模块顶层有裸 await',
        line: awaited.line,
        message: `${rel}:${awaited.line} 顶层裸 await 让激活一直等下去，插件不会自己好。`,
        fix: '把 await 挪进 apply()/activate()，不要在模块顶层等待服务',
        text,
      });
    }

    const exit = /(?:^|[^\w.$])process\.exit\s*\(/.exec(masked);
    if (exit) {
      return judgeOne({
        ruleId: 'P018',
        title: '插件接管了进程退出',
        line: lineOf(masked, exit.index),
        message: '调用了 process.exit：它直接终止宿主进程，当前所有会话一起掉线。',
        fix: '删掉退出调用，把清理放进 dispose() 或 apply() 返回的清理函数',
        text,
      });
    }

    const signalMasked = maskCode(text, { keepStrings: true });
    const signal = /(?:^|[^\w.$])process\.on\s*\(\s*["'](?:SIGINT|SIGTERM|SIGQUIT|SIGHUP)["']/.exec(signalMasked);
    if (signal) {
      return judgeOne({
        ruleId: 'P019',
        title: '插件接管了宿主信号',
        line: lineOf(signalMasked, signal.index),
        message: '监听了进程退出信号：宿主退出流程被插件接管，关闭时可能卡死或丢状态。',
        fix: '不要监听 SIGINT/SIGTERM；用 dispose() 或 ctx.effect() 做清理',
        text,
      });
    }

    /* A client half is a browser bundle loaded through __ModuleLoader__.load, whose factory gets a
     * real `require`. The package is type=module, so judging that file as an ESM module reports a
     * require that actually runs in the browser — a false positive that blocks every client edit. */
    const clientBundle = /__ModuleLoader__\s*\.\s*load/.test(text)
      || /(?:^|[/\\])(?:client|web|ui)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(rel);
    const esm = !clientBundle && (rel.endsWith('.mjs') || rel.endsWith('.mts') || nearestPackageType(filePath) === 'module');
    if (esm) {
      const req = /(?:^|[^\w.$])require\s*\(/.exec(masked);
      if (req) {
        return judgeOne({
          ruleId: 'P016',
          title: 'ESM 模块里用了 require',
          line: lineOf(masked, req.index),
          message: 'ESM 插件里没有 require：加载即 ReferenceError，整个 profile 起不来。',
          fix: "改用 import，或 import { createRequire } from 'node:module' 后 const require = createRequire(import.meta.url)",
          text,
        });
      }
    }
    return null;
  }

  if (/(?:^|\/)cordis\.patch\.yml$/.test(rel)) {
    const dup = duplicatePatchId(text);
    if (dup) {
      return judgeOne({
        ruleId: 'P009',
        title: 'patch 里同一个 id 出现两次',
        line: dup.line,
        message: `id: ${dup.id} 在第 ${dup.first} 行和第 ${dup.line} 行重复，后面的会静默覆盖前面的。`,
        fix: '同一个 id 只保留一处，合并配置或改 id',
        text,
      });
    }
  }

  if (/(?:^|\/)cordis\.patch\.yml$/.test(rel)) {
    const owner = path.dirname(filePath);
    let ownerPkg = null;
    try { ownerPkg = JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8')); } catch { ownerPkg = null; }
    if (ownerPkg && typeof ownerPkg === 'object') {
      const declared = new Set([
        ownerPkg.name,
        ...Object.keys(ownerPkg.dependencies || {}),
        ...Object.keys(ownerPkg.devDependencies || {}),
        ...Object.keys(ownerPkg.peerDependencies || {}),
      ].filter(Boolean));
      const names = [...String(text).matchAll(/^\s*name:\s*["']?([^\s#'"]+)/gm)].map((match) => match[1]);
      for (const name of names) {
        if (declared.has(name) || name.startsWith('.') || name.startsWith('/') || name.startsWith('link:')) continue;
        return judgeOne({
          ruleId: 'P010',
          title: 'patch 引用了没有声明的包',
          line: lineOf(text, String(text).indexOf(name)),
          message: `patch 里的 name: ${name} 不在 ${path.basename(owner) || 'nearest'}/package.json 的依赖里，loader 找不到这个包，激活会失败。`,
          fix: '把它加进 dependencies，或改成已声明的包名',
          text,
        });
      }
    }
  }

  if (/(?:^|\/)package\.json$/.test(rel)) {
    try {
      JSON.parse(text);
    } catch (error) {
      return judgeOne({
        ruleId: 'P001',
        title: 'package.json 解析失败',
        severity: 'fatal',
        line: 1,
        message: `JSON 语法不合法：${String(error?.message || error)}`,
        fix: '修好 JSON 语法，装上去必然激活失败',
        text,
      });
    }
  }

  if (/(?:^|\/)(?:cordis\.patch\.yml|package\.json)$/.test(rel)) {
    const secret = SECRET.exec(text);
    if (secret && !/\$\{|apiKeyEnv|process\.env/.test(secret[0])) {
      return judgeOne({
        ruleId: 'secret',
        title: '凭据只写 apiKeyEnv 不写明文',
        line: lineOf(text, secret.index),
        message: '配置里出现疑似明文凭据：会随 profile 一起被备份和同步。',
        fix: '改成 apiKeyEnv: SOME_ENV_VAR，值放到环境变量里',
        text,
      });
    }
  }

  return null;
}

/** Read one file and judge it; used by the CLI which has the plugin root at hand. */
export function judgeFile(file, options = {}) {
  const text = readTextSafe(file);
  if (text == null) return null;
  const finding = inspectText(text, file, options);
  if (!finding) return null;
  const rel = String(options.rel || fallbackRel(file)).replace(/\\/g, '/');
  return { ...finding, file: rel };
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, out, depth + 1);
    } else if (entry.isFile() && (CODE.test(entry.name) || entry.name === 'package.json' || entry.name === 'cordis.patch.yml')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Judge every loadable file under `dir`, using paths relative to `dir`.
 * Findings already reported by another producer with the same rule id, file and line are
 * skipped so the CLI never lists the same problem twice.
 */
export function judgeDir(dir, existing = []) {
  const root = path.resolve(dir);
  const reported = new Set((Array.isArray(existing) ? existing : []).map((item) => `${item.ruleId}|${item.file}|${item.line ?? 0}`));
  const findings = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    let finding = null;
    try {
      finding = judgeFile(file, { rel });
    } catch {
      finding = null;
    }
    if (!finding) continue;
    const key = `${finding.ruleId}|${finding.file}|${finding.line ?? 0}`;
    if (reported.has(key)) continue;
    reported.add(key);
    findings.push(finding);
  }
  return findings;
}

/**
 * Rules whose judgement now lives in this module. The CLI's older lint rules are dropped
 * when the shared judgement covers the same shape, so the CLI cannot report a problem the
 * runtime guard would allow (or the other way round) for the same file and content.
 */
export const JUDGE_SUPERSEDES = new Map([
  ['R005', ['P018', 'P019']],
  ['R011', ['P014', 'P015']],
  ['R012', ['P016']],
  ['R014', ['P009']],
  ['R015', ['secret']],
]);

/** Replace superseded lore-lint findings with the shared judgement and append the rest. */
export function mergeJudge(dir, findings = []) {
  const kept = (Array.isArray(findings) ? findings : []).filter((finding) => !JUDGE_SUPERSEDES.has(finding.ruleId));
  return [...kept, ...judgeDir(dir, kept)];
}
