/**
 * Preflight checks: run the lore's static guards against a plugin source directory
 * before it is installed, so a known crash shape is caught at authoring time.
 * Pure Node, zero dependencies.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SOURCE_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'test', '__tests__']);
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;

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
      if (SKIP_DIR.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, out, depth + 1);
    } else if (entry.isFile() && (SOURCE_EXT.test(entry.name) || entry.name === 'package.json' || entry.name === 'cordis.patch.yml')) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function guardTargets(guard) {
  if (guard.kind === 'manifest') return /(?:^|[/\\])package\.json$/;
  if (guard.kind === 'config') return /(?:^|[/\\])cordis\.patch\.yml$/;
  return SOURCE_EXT;
}

/**
 * @param {string} dir plugin source directory
 * @param {Array} rules lore rules (only those with `guard` and kind source-regex|manifest|config)
 * @returns {Array<{ruleId:string,title:string,severity:string,file:string,line:number,message:string,fix:string}>}
 */
export function checkSource(dir, rules = []) {
  const root = path.resolve(dir);
  const findings = [];
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [{ ruleId: 'dir', title: '目录不存在', severity: 'lint', file: root, line: 0, message: `找不到 ${root}`, fix: '确认传入的是插件源码目录' }];
  }
  if (!stat.isDirectory()) return [{ ruleId: 'dir', title: '不是目录', severity: 'lint', file: root, line: 0, message: `${root} 不是目录`, fix: '传插件源码目录' }];

  const guarded = rules.filter((rule) => rule?.guard?.pattern && ['source-regex', 'manifest', 'config'].includes(rule.guard.kind));
  if (!guarded.length) return findings;

  const files = walk(root);
  for (const file of files) {
    const rel = path.relative(root, file) || file;
    const extMatch = rel.endsWith('package.json') || rel.endsWith('cordis.patch.yml') ? rel : SOURCE_EXT.test(rel) ? rel : null;
    if (!extMatch) continue;
    let text = '';
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rule of guarded) {
      const { pattern, message, exclude } = rule.guard;
      if (!guardTargets(rule.guard).test(file)) continue;
      if (exclude) {
        let skip = false;
        try {
          skip = new RegExp(exclude, 'i').test(rel) || new RegExp(exclude, 'i').test(text);
        } catch {
          skip = false;
        }
        if (skip) continue;
      }
      let re;
      try {
        re = new RegExp(pattern, 'im');
      } catch {
        continue;
      }
      const m = re.exec(text);
      if (!m) continue;
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity ?? 'lint',
        file: rel,
        line: lineOf(text, m.index),
        message: message || rule.cause || rule.title,
        fix: rule.fix || '',
      });
    }
  }
  return findings;
}

export function renderAll(findings, dir) {
  const order = { fatal: 0, boot: 1, lint: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  const fatal = sorted.filter((item) => item.severity === 'fatal').length;
  const boot = sorted.filter((item) => item.severity === 'boot').length;
  if (!sorted.length) return `预检通过：${dir} 没有发现会导致崩溃或激活失败的形态。`;
  const lines = [`预检发现 ${sorted.length} 处问题（${dir}）：致命 ${fatal} · 起不来 ${boot} · 建议 ${sorted.length - fatal - boot}`, ''];
  for (const item of sorted.slice(0, 24)) {
    lines.push(`- [${item.severity}] ${item.ruleId} ${item.title} · ${item.file}${item.line ? `:${item.line}` : ''}`);
    if (item.message) lines.push(`  ${item.message}`);
    if (item.fix) lines.push(`  改法：${item.fix}`);
  }
  if (sorted.length > 24) lines.push(`… 还有 ${sorted.length - 24} 处，先修致命项再复查。`);
  if (fatal || boot) lines.push('', '装之前先把 fatal / boot 清零，否则装上去就是一次 harness 崩溃。');
  return lines.join('\n');
}

export function renderFindings(findings, dir) {
  if (!findings.length) return `预检通过：${dir} 没有命中已知崩溃形态。`;
  const lines = [`预检发现 ${findings.length} 处已知崩溃形态（${dir}）：`];
  for (const finding of findings.slice(0, 20)) {
    lines.push(`- [${finding.ruleId}] ${finding.title} · ${finding.file}:${finding.line}`);
    if (finding.message) lines.push(`  ${finding.message}`);
    if (finding.fix) lines.push(`  改法：${finding.fix}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------ structural preflight */

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

function readText(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Index just past the call that opens at `start` (which points at '('). */
function matchParen(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (!depth) return i;
    }
  }
  return -1;
}

function toolRegistrations(text) {
  const out = [];
  const re = /tools\.register\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchParen(text, open);
    if (close === -1) {
      out.push({ start: m.index, end: text.length, body: text.slice(m.index), broken: true });
      break;
    }
    out.push({ start: m.index, end: close, body: text.slice(m.index, close + 1), broken: false });
    re.lastIndex = close + 1;
  }
  return out;
}

function finding(severity, ruleId, title, file, line, message, fix) {
  return { severity, ruleId, title, file, line, message, fix };
}

/** Blank out comments, string literals and regex literals so pattern checks do not fire on
 *  the text of the check itself (or on a message that merely mentions `__dirname`). */
export function startsRegex(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === ')' || c === ']' || c === '}' || c === '.' || /[A-Za-z0-9_$]/.test(c)) return false;
    return true;
  }
  return true;
}

/** A throw is module-level only when it sits at brace depth 0; `try { ... } catch` inside apply() is fine. */
export function topLevelThrow(text) {
  const lines = text.split('\n');
  let depth = 0;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    if (depth === 0 && /^\s*(?:export\s+)?(?:async\s+)?throw\b/.test(line)) return { line: at + 1, text: line.trim() };
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

function stripNoise(text) {
  const out = text.split('');
  let quote = null;
  let inLine = false;
  let inBlock = false;
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      blank(i, i + 1);
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        blank(i, i + 2);
        i += 1;
        inBlock = false;
      } else blank(i, i + 1);
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        blank(i, i + 2);
        i += 1;
        continue;
      }
      blank(i, i + 1);
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      blank(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      blank(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === '/' && startsRegex(text, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (c === '\\') { j += 1; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
      }
      blank(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      blank(i, i + 1);
      continue;
    }
  }
  return out.join('');
}

function syntaxFindings(root, relFiles) {
  const findings = [];
  for (const rel of relFiles) {
    const file = path.join(root, rel);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 8000 });
    if (result.status === 0) continue;
    const stderr = String(result.stderr || result.error?.message || 'node --check 失败');
    const lineMatch = /:(\d+)\n/.exec(stderr);
    findings.push(finding('boot', 'P013', '文件语法不合法（装上去必然激活失败）', rel, lineMatch ? Number(lineMatch[1]) : 0, stderr.split('\n').find((line) => /error/i.test(line))?.trim() || stderr.split('\n')[0], '先 node --check 修好语法'));
  }
  return findings;
}

/** package.json / cordis.patch.yml / entry wiring, checked the way the loader checks it. */
export function preflight(dir) {
  const root = path.resolve(dir);
  const findings = [];
  const pkgFile = path.join(root, 'package.json');
  const pkgText = readText(pkgFile);
  if (!pkgText) return [finding('fatal', 'P001', '缺少 package.json', 'package.json', 0, `${root} 下没有可读的 package.json`, '插件必须有 package.json')];
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    return [finding('fatal', 'P001', 'package.json 解析失败', 'package.json', 1, String(error?.message || error), '修好 JSON 语法再装')];
  }

  /* --- manifest --- */
  if (!pkg.name) findings.push(finding('fatal', 'P002', 'package.json 缺 name', 'package.json', 0, 'loader 按 name 认插件', '补 "name"'));
  if (!pkg.version) findings.push(finding('lint', 'P003', 'package.json 缺 version', 'package.json', 0, '安装与升级要靠 version 比对', '补 "version"'));
  const filesField = Array.isArray(pkg.files) ? pkg.files : null;
  if (filesField && !filesField.includes('lib') && !filesField.includes('dist')) {
    /* informational only: files is a publish whitelist, not an install requirement */
  }

  const exportEntries = [];
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const [key, value] of Object.entries(pkg.exports)) {
      const target = typeof value === 'string' ? value : value?.import || value?.default || null;
      if (typeof target === 'string' && !target.includes('*') && !target.startsWith('node:')) exportEntries.push([`.${key === '.' ? '' : key}`, target]);
    }
  }
  const mainEntry = typeof pkg.main === 'string' ? pkg.main : null;
  if (mainEntry && !fs.existsSync(path.join(root, mainEntry))) findings.push(finding('fatal', 'P005', 'main 指向的文件不存在', 'package.json', 0, `main = ${mainEntry}`, '改 main 或补文件'));
  for (const [key, target] of exportEntries) {
    const file = path.join(root, target);
    if (!fs.existsSync(file)) findings.push(finding('boot', 'P006', `exports["${key}"] 指向的文件不存在`, 'package.json', 0, `${key} → ${target}`, '补上文件或删掉这条 exports'));
  }

  /* --- bundle patch --- */
  const bundle = pkg.dsh?.bundle;
  const patchRel = typeof bundle === 'string' ? bundle : bundle?.patch || bundle?.file || null;
  if (bundle && !patchRel) findings.push(finding('boot', 'P007', 'dsh.bundle 没写 patch 文件', 'package.json', 0, 'dsh.bundle 需要一个 patch 路径', '写 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }'));
  let patchText = null;
  if (patchRel) {
    const patchFile = path.join(root, patchRel);
    patchText = readText(patchFile);
    if (patchText == null) findings.push(finding('boot', 'P008', 'cordis.patch.yml 不存在', 'package.json', 0, `dsh.bundle 指向 ${patchRel}`, '补 cordis.patch.yml'));
  } else if (fs.existsSync(path.join(root, 'cordis.patch.yml'))) {
    patchText = readText(path.join(root, 'cordis.patch.yml'));
  }
  if (patchText != null) {
    const ids = new Map();
    patchText.split('\n').forEach((line, index) => {
      const idMatch = /^\s*-\s*(?:id:\s*)([^\s#]+)/.exec(line);
      if (idMatch) {
        const id = idMatch[1];
        if (ids.has(id)) findings.push(finding('fatal', 'P009', 'patch 里同一个 id 出现两次', 'cordis.patch.yml', index + 1, `id "${id}" 重复（第一次在第 ${ids.get(id)} 行）`, '同一个 id 只留一行；要叠加就合并 config'));
        else ids.set(id, index + 1);
      }
      if (/^\s*-\s*insert:\s*$/.test(line)) {
        /* insert rows are positional groups; nothing to verify beyond YAML shape */
      }
    });
    const patchNames = [...patchText.matchAll(/^\s*name:\s*([^\s#]+)/gm)].map((m) => m[1]);
    for (const name of patchNames) {
      const known = name === pkg.name || Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);
      if (!known) findings.push(finding('boot', 'P010', 'patch 引用了没有声明的包', 'cordis.patch.yml', 0, `name: ${name} 不在依赖里`, `把它加进 dependencies，或确认包名`));
    }
    if (/^\s*-\s*id:\s*$\s*$/m.test(patchText) || /^\s*id:\s*$/m.test(patchText)) findings.push(finding('lint', 'P011', 'patch 里有空 id', 'cordis.patch.yml', 0, 'id 为空的行会被 loader 忽略或报错', '删掉或填 id'));
    if (/\t/.test(patchText)) findings.push(finding('lint', 'P012', 'patch 里用了 tab 缩进', 'cordis.patch.yml', 0, 'YAML 不接受 tab 缩进', '改成空格'));
  }

  /* --- source files --- */
  const files = walk(root).filter((file) => SOURCE_EXT.test(file));
  const entryFiles = files
    .map((file) => path.relative(root, file))
    .filter((rel) => /(?:^|[\/\\])(?:index|main|client|server|plugin)\.(?:mjs|cjs|js|ts)$/.test(rel) || exportEntries.some(([, target]) => path.normalize(target).replace(/^\.\//, '') === rel))
    .slice(0, 20);
  findings.push(...syntaxFindings(root, entryFiles));

  const toolNames = new Map();
  for (const file of files) {
    const rel = path.relative(root, file) || file;
    const raw = readText(file);
    if (raw == null) continue;
    const text = stripNoise(raw);
    const isClient = /(?:^|[/\\])(?:client|web|ui)(?:[/\\]|\.)/.test(rel);

    const topThrow = topLevelThrow(text);
    if (topThrow) {
      findings.push(finding('boot', 'P014', '模块顶层有 throw', rel, topThrow.line, '顶层抛错会让整个插件激活失败', '挪进 apply() 或包 try/catch'));
    }
    if (/(^|\n)\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s/m.test(text.split('\n').slice(0, 8).join('\n'))) {
      findings.push(finding('boot', 'P015', '模块顶层有裸 await', rel, 1, '`type: module` 顶层 await 会拖住 loader 并让激活顺序不可预测', '挪进 apply() 里的异步初始化'));
    }
    /* createRequire() is the sanctioned way to keep a require in ESM, including a local `require` binding. */
    const bareRequire = /\brequire\s*\(/.exec(text);
    const hasCreateRequire = /\bcreateRequire\s*\(|(?:const|let|var)\s+require\s*=/.test(text);
    if (bareRequire && !hasCreateRequire && /(^|\n)\s*import\s/.test(text)) {
      findings.push(finding('fatal', 'P016', 'ESM 文件里用了 require', rel, lineOf(text, bareRequire.index), 'ESM 没有 require', '改成 import 或 createRequire'));
    }
    if (/\b__dirname\b|\b__filename\b/.test(text) && /(^|\n)\s*import\s/.test(text)) {
      findings.push(finding('fatal', 'P017', 'ESM 文件里用了 __dirname/__filename', rel, lineOf(text, text.search(/__dirname|__filename/)), 'ESM 里这两个不存在', '用 import.meta.url + fileURLToPath'));
    }
    if (/process\.exit\s*\(/.test(text)) {
      findings.push(finding('fatal', 'P018', '插件调用了 process.exit', rel, lineOf(text, text.search(/process\.exit\s*\(/)), '插件退出会带走整个宿主进程', '交给宿主退出，不要在插件里 exit'));
    }
    if (/process\.on\s*\(\s*['"](?:exit|SIGTERM|SIGINT)['"]/.test(text)) {
      findings.push(finding('fatal', 'P019', '插件接管了宿主退出信号', rel, lineOf(text, text.search(/process\.on\s*\(\s*['"](?:exit|SIGTERM|SIGINT)/)), '抢退出信号会和宿主的清理打架', '用 ctx.effect 的 disposer 做清理'));
    }
    if (isClient && !/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(?:apply|activate)\b/.test(text) && !/ctx\.effect\s*\(/.test(text)) {
      findings.push(finding('boot', 'P020', 'client 入口没有 apply/activate', rel, 1, 'client 插件没导出激活入口时 boot 会整体失败', '导出 apply(ctx) 或在 ctx.effect 里注册'));
    }

    /* tools.register contract — the exact shape that killed this session's activation */
    for (const call of toolRegistrations(text)) {
      const line = lineOf(text, call.start);
      const rawBody = raw.slice(call.start, call.end + 1);
      if (call.broken) {
        findings.push(finding('fatal', 'P021', 'tools.register 调用没闭合', rel, line, '括号没配对，loader 读到的是残缺对象', '补全括号'));
        continue;
      }
      const nameMatch = /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(rawBody);
      const name = nameMatch ? nameMatch[1] : null;
      if (!name) findings.push(finding('fatal', 'P022', 'tools.register 缺 name', rel, line, '工具有 name 才能在 listTools 里出现', '补 name'));
      else {
        if (!TOOL_NAME_RE.test(name)) findings.push(finding('lint', 'P023', '工具名不合规范', rel, line, `${name} 应为小写+下划线`, '改名'));
        if (toolNames.has(name)) findings.push(finding('fatal', 'P024', '工具名重复', rel, line, `${name} 已在 ${toolNames.get(name)} 注册过`, '同一名字只能注册一次'));
        else toolNames.set(name, `${rel}:${line}`);
      }
      const hasOutput = /\boutput\s*:/.test(call.body) || /\bwith(?:Tool)?Output\s*\(/.test(call.body) || /\.\.\./.test(call.body);
      if (!hasOutput) findings.push(finding('fatal', 'P025', '工具没声明 output', rel, line, `工具 ${name || '(无名)'} 缺 output { schema, render }，激活会抛 TypeError`, '加 output: { schema, render: (_args, value) => [...] }'));
      else if (/\boutput\s*:/.test(call.body)) {
        if (!/\bschema\s*:/.test(call.body)) findings.push(finding('fatal', 'P026', 'output 缺 schema', rel, line, 'output.schema 是必填', '补 schema: { type: "object", properties: {...} }'));
        if (!/\brender\s*:/.test(call.body)) findings.push(finding('fatal', 'P027', 'output 缺 render', rel, line, 'output.render 是必填函数', '补 render: (_args, value) => [{ type: "text", text }]'));
      }
      if (!/\bparameters\s*:/.test(call.body)) findings.push(finding('lint', 'P028', '工具没声明 parameters', rel, line, `工具 ${name || '(无名)'} 缺参数 schema，模型看不到入参`, '补 parameters: { type: "object", properties: {...} }'));
      if (!/\bexecute\s*:/.test(call.body) && !/\bhandler\s*:/.test(call.body)) findings.push(finding('fatal', 'P029', '工具没有 execute', rel, line, `工具 ${name || '(无名)'} 没有可调用的实现`, '补 execute: async (args) => ...'));
    }

    /* services: plain property reads throw on undeclared services */
    const serviceReads = [...text.matchAll(/ctx\.([a-z][A-Za-z0-9_]*)\b(?!\s*\))/g)]
      .map((m) => m[1])
      .filter((key) => !['effect', 'get', 'set', 'on', 'off', 'emit', 'inject', 'logger', 'root', 'scope', 'plugin', 'dispose', 'start', 'stop', 'emitEvent'].includes(key));
    if (serviceReads.length && !/try\s*\{/.test(text) && !/ctx\.get\s*\(/.test(text)) {
      findings.push(finding('boot', 'P030', '直接读 ctx 服务但没有兜底', rel, 1, `读了 ${[...new Set(serviceReads)].slice(0, 3).join('、')}；服务未声明时读取会抛错`, '用 try/catch 或 ctx.get(name) 读服务'));
    }
  }

  /* locale files must stay flat */
  for (const file of walk(root).filter((f) => /(?:^|[/\\])locale[/\\].*\.json$/.test(f))) {
    const text = readText(file);
    if (text == null) continue;
    try {
      const doc = JSON.parse(text);
      const nested = Object.values(doc).filter((value) => value && typeof value === 'object');
      if (nested.length) findings.push(finding('lint', 'P031', 'locale 用了嵌套 key', path.relative(root, file) || file, 1, '宿主按扁平 key 取值（"meta.title"）', '改成扁平 key'));
    } catch (error) {
      findings.push(finding('boot', 'P032', 'locale JSON 解析失败', path.relative(root, file) || file, 1, String(error?.message || error), '修 JSON'));
    }
  }

  /* hardcoded machine paths in config */
  if (patchText && /(?:^|\s)(?:~\/|\/(?:Users|home)\/[^\s"']+)/m.test(patchText)) {
    findings.push(finding('lint', 'P033', 'patch 里写死了本机绝对路径', 'cordis.patch.yml', 0, '换机器/换用户就失效', '改成 ${DSH_HOME} 或相对路径'));
  }
  return findings;
}
