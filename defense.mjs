/**
 * Live defense: refuse a tool call before its side effect when the proposed change is
 * a known crash shape for the running profile.
 *
 * Two host mechanisms, used for what each is good at:
 * - `tools/pre-execute` (async, waterfall): read the candidate source, run the static
 *   preflight, deny with a reason. Runs on plugin install / enable.
 * - `ctx.tools.guard()` (sync, monotonic): cheap checks on the proposed text of a
 *   write/edit into a file the running host actually loads. Nothing can force-allow it.
 *
 * Everything fails open: a defense plugin must not take the host down, and must not
 * block ordinary development. Only shapes proven to crash this machine are refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pluginIndex } from './core.mjs';
import { preflight, topLevelThrow } from './guard.mjs';

/** Rule ids solid enough to refuse an install: no spread/loader false positives. */
const BLOCKING = new Set([
  'P001', 'P002', 'P005', 'P007', 'P008', 'P009', 'P010',
  'P013', 'P014', 'P016', 'P018', 'P019', 'P021',
]);

const SKIP_CALL = /(?:^|[/\\])(?:scripts?|bin|tools|test|tests|__tests__|docs?|examples?)(?:[/\\]|$)/;

const CODE = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/;

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isInside(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

/**
 * Which live surfaces the running host loads, and where a file sits relative to them.
 * @param {string} profileDir
 * @returns {{profileDir:string, plugins:Array<{name:string,dir:string,linked:boolean}>, patchFile:string, pkgFile:string}}
 */
export function liveSurfaces(profileDir = process.env.DSH_PROFILE_DIR || '') {
  const dir = profileDir ? path.resolve(profileDir) : '';
  const plugins = pluginIndex(dir).filter((entry) => entry.dir && fs.existsSync(entry.dir));
  return {
    profileDir: dir,
    plugins,
    patchFile: dir ? path.join(dir, 'cordis.patch.yml') : '',
    pkgFile: dir ? path.join(dir, 'package.json') : '',
  };
}

/**
 * Classify a path as a live host surface. Linked dev trees count as live because the
 * host loads them through symlink; `linked` lets callers keep dev-friendly behavior.
 * @param {string} file
 * @param {ReturnType<typeof liveSurfaces>} surfaces
 */
export function classify(file, surfaces) {
  if (!file) return { live: false };
  const abs = path.resolve(file);
  if (surfaces.pkgFile && abs === surfaces.pkgFile) return { live: true, kind: 'profile-manifest', name: 'profile' };
  if (surfaces.patchFile && abs === surfaces.patchFile) return { live: true, kind: 'profile-patch', name: 'profile' };
  for (const entry of surfaces.plugins) {
    if (!isInside(abs, entry.dir)) continue;
    const rel = path.relative(entry.dir, abs);
    const linked = !isInside(entry.dir, surfaces.profileDir);
    if (/(?:^|[/\\])(?:cordis\.patch\.yml|package\.json)$/.test(rel)) return { live: true, kind: 'plugin-manifest', name: entry.name, dir: entry.dir, rel, linked };
    if (CODE.test(rel)) return { live: true, kind: 'plugin-source', name: entry.name, dir: entry.dir, rel, linked };
    return { live: true, kind: 'plugin-other', name: entry.name, dir: entry.dir, rel, linked };
  }
  if (surfaces.profileDir && isInside(abs, surfaces.profileDir)) return { live: true, kind: 'profile-other', name: 'profile' };
  return { live: false };
}

function nearestPackageType(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i += 1) {
    const text = readTextSafe(path.join(dir, 'package.json'));
    if (text) {
      try {
        return JSON.parse(text).type === 'module' ? 'module' : 'commonjs';
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Crash shapes detectable in one file, without a subprocess. Deliberately narrow:
 * a shape that only *might* break is a lint finding elsewhere, not a refusal here.
 * @param {string} text proposed file content
 * @param {string} file absolute path the content would be written to
 * @returns {null | {ruleId:string, title:string, line:number, message:string, fix:string, snippet:string}}
 */
export function inspectText(text, file) {
  if (typeof text !== 'string' || !text) return null;
  const rel = path.basename(file);
  if (SKIP_CALL.test(file)) return null;

  if (CODE.test(rel)) {
    const thrown = topLevelThrow(text);
    if (thrown) {
      return {
        ruleId: 'P014',
        title: '模块顶层有 throw',
        line: thrown.line,
        message: `${rel}:${thrown.line} 顶层 throw 会让插件激活直接失败，宿主启动链断在这里`,
        fix: '挪进 apply()/activate()，或用 try/catch 包住并记日志',
        snippet: thrown.text,
      };
    }
    const exit = /(?:^|[^\w.])process\.exit\s*\(/m.exec(text);
    if (exit) {
      return {
        ruleId: 'P018',
        title: '插件调用了 process.exit',
        line: lineOf(text, exit.index),
        message: '插件进程里调 process.exit 会直接杀掉宿主，所有会话一起掉线',
        fix: '改成抛给 ctx 报错或返回失败结果，让加载器决定是否停用',
        snippet: text.slice(exit.index, exit.index + 60).split('\n')[0],
      };
    }
    const signal = /process\s*\.\s*on\s*\(\s*['"](?:SIGINT|SIGTERM|SIGQUIT|SIGHUP)['"]/.exec(text);
    if (signal) {
      return {
        ruleId: 'P019',
        title: '插件接管了宿主退出信号',
        line: lineOf(text, signal.index),
        message: '注册 SIGINT/SIGTERM 监听会抢宿主的退出流程，清理顺序错乱时进程卡死或半死',
        fix: '删除信号监听，清理逻辑放进 ctx.effect 的 disposer',
        snippet: text.slice(signal.index, signal.index + 60).split('\n')[0],
      };
    }
    if (rel.endsWith('.mjs') || nearestPackageType(file) === 'module') {
      const req = /(?:^|[^\w.$])require\s*\(/m.exec(text);
      if (req) {
        return {
          ruleId: 'P016',
          title: 'ESM 文件里用了 require',
          line: lineOf(text, req.index),
          message: 'ESM 加载器下 require 未定义，激活时抛 ReferenceError',
          fix: '改成 import，或用 createRequire(import.meta.url)',
          snippet: text.slice(req.index, req.index + 60).split('\n')[0],
        };
      }
    }
  }

  if (/(?:^|[/\\])cordis\.patch\.yml$/.test(file)) {
    const ids = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*-?\s*id:\s*['"]?([\w./:@-]+)['"]?\s*$/.exec(lines[i]);
      if (m) ids.push({ id: m[1], line: i + 1 });
    }
    const seen = new Map();
    for (const entry of ids) {
      if (!seen.has(entry.id)) {
        seen.set(entry.id, entry.line);
        continue;
      }
      return {
        ruleId: 'P009',
        title: 'patch 里同一个 id 出现两次',
        line: entry.line,
        message: `id "${entry.id}" 已在第 ${seen.get(entry.id)} 行出现，重复 id 会让加载器报错并中断整组插件`,
        fix: '改成唯一 id，或用 override 修改已有条目',
        snippet: lines[entry.line - 1].trim(),
      };
    }
  }

  if (/(?:^|[/\\])package\.json$/.test(file)) {
    try {
      JSON.parse(text);
    } catch (error) {
      return {
        ruleId: 'P001',
        title: 'package.json 解析失败',
        line: 1,
        message: String(error?.message || error),
        fix: '修好 JSON 语法（常见是尾逗号或漏引号）',
        snippet: '',
      };
    }
  }

  if (/(?:^|[/\\])(?:cordis\.patch\.yml|package\.json)$/.test(file)) {
    const secret = /(?:apiKey|api_key|token|secret)\s*:\s*['"]?(?:sk-|ghp_|xoxb-)[\w-]{8,}/i.exec(text);
    if (secret) {
      return {
        ruleId: 'secret',
        title: '配置里写了明文凭据',
        line: lineOf(text, secret.index),
        message: '凭据进配置会被打包、上传、进日志',
        fix: '改成 apiKeyEnv: YOUR_ENV_NAME，由宿主从环境读',
        snippet: '',
      };
    }
  }
  return null;
}

/** Reconstruct the file a write/edit would leave behind. */
export function proposedText(name, args, read = readTextSafe) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'write' || name === 'Write') return typeof args.content === 'string' ? { file: args.file_path ?? args.path, text: args.content } : null;
  if (name === 'edit' || name === 'Edit') {
    const file = args.file_path ?? args.path;
    const before = typeof file === 'string' ? read(file) : null;
    if (before == null) return null;
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null;
    if (!args.old_string) return null;
    if (args.replace_all === true) return { file, text: before.split(args.old_string).join(args.new_string) };
    const at = before.indexOf(args.old_string);
    if (at < 0) return null;
    return { file, text: `${before.slice(0, at)}${args.new_string}${before.slice(at + args.old_string.length)}` };
  }
  return null;
}

/** The refusal text the calling agent receives as this call's error result. */
export function blockReason({ surface, finding, file, action }) {
  const where = surface?.name && surface.name !== 'profile' ? `插件：${surface.name}\n` : '';
  const loc = file ? `${file}${finding.line ? `:${finding.line}` : ''}` : 'profile';
  const lines = [
    '[CRASH_LORE_BLOCKED] 本次操作未执行。',
    '',
    `${where}位置：${loc}`,
    `规则：${finding.ruleId} ${finding.title}`,
    `原因：${finding.message}`,
  ];
  if (finding.snippet) lines.push(`证据：${finding.snippet}`);
  lines.push(`风险：这一步会在 running profile 里生效，宿主激活/热重载时崩溃，当前所有会话一起掉线。`);
  lines.push(`建议：${finding.fix}`);
  if (action) lines.push(`改好后重新提交这次${action}；你仍可以继续读代码、改开发副本、跑测试。`);
  else lines.push('改好后重新提交；你仍可以继续读代码、改开发副本、跑测试。');
  return lines.join('\n');
}

export function denial(reason, finding) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'CrashLoreBlocked',
      code: 'CRASH_LORE_BLOCKED',
      rule: finding?.ruleId,
      title: finding?.title,
    },
  };
}

/**
 * Sync guard: refuse write/edit whose resulting text is a known crash shape in a live file.
 * @returns {string|undefined} denial reason, or undefined to allow
 */
export function guardWrite(exec, options = {}) {
  const name = exec?.name;
  if (name !== 'write' && name !== 'Write' && name !== 'edit' && name !== 'Edit') return undefined;
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  const proposed = proposedText(name, exec.arguments, options.read);
  if (!proposed || !proposed.file) return undefined;
  const surface = classify(proposed.file, surfaces);
  if (!surface.live) return undefined;
  if (surface.kind !== 'plugin-source' && surface.kind !== 'plugin-manifest' && surface.kind !== 'profile-patch' && surface.kind !== 'profile-manifest') return undefined;
  const finding = inspectText(proposed.text, path.resolve(proposed.file));
  if (!finding) return undefined;
  const reason = blockReason({ surface, finding, file: path.resolve(proposed.file), action: '写入' });
  options.onDeny?.(finding, surface, proposed.file, reason);
  return reason;
}

/** Destructive shell commands whose *target* is a live root (or a parent of one). */
const DESTRUCTIVE = /(?:^|[;&|]\s*)(rm|mv|rsync)\s+([^;&|]+)/g;

/**
 * Resolve what a destructive command would remove. Only the argument path counts:
 * deleting a scratch file inside a linked dev tree is ordinary work, while deleting
 * the tree the host is loading is not.
 * @returns {string[]}
 */
export function shellTargets(command, cwd = process.cwd()) {
  const out = [];
  for (const match of String(command).matchAll(DESTRUCTIVE)) {
    const [, verb, rest] = match;
    const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const paths = tokens
      .map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter((token) => token && !token.startsWith('-'))
      .filter((token) => !/^\d+$/.test(token));
    const targets = verb === 'rsync' ? paths.slice(-1) : paths;
    for (const target of targets) out.push(path.resolve(cwd, target));
  }
  return out;
}

/**
 * A wholesale delete/move of a directory the running host loads. Text-level writes from
 * bash cannot be inspected, so only this categorical case is refused.
 * @returns {string|undefined}
 */
export function guardShell(exec, options = {}) {
  if (exec?.name !== 'bash' && exec?.name !== 'Bash') return undefined;
  const command = exec.arguments?.command;
  if (typeof command !== 'string' || !command) return undefined;
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  const roots = [surfaces.profileDir, ...surfaces.plugins.map((entry) => entry.dir)].filter(Boolean);
  const cwd = exec.arguments?.cwd ?? exec.arguments?.workdir ?? options.cwd ?? process.cwd();
  const targets = shellTargets(command, cwd);
  const hit = targets.find((target) => roots.some((root) => target === path.resolve(root) || path.resolve(root).startsWith(`${target}${path.sep}`)));
  if (!hit) return undefined;
  const reason = [
    '[CRASH_LORE_BLOCKED] 本次命令未执行。',
    '',
    `位置：${hit}`,
    '规则：live-delete 删除或移动了正在运行的插件目录/配置',
    '原因：宿主正从这些文件加载，热重载或下次激活读到缺失文件，整个 profile 起不来。',
    '建议：要换版本走 plugin_manager；要清理先停用插件，或只改开发副本再整体替换。单个文件的增删改不受这条限制。',
    '你仍可以继续读代码、改开发副本、跑测试。',
  ].join('\n');
  options.onDeny?.({ ruleId: 'live-delete', title: '删除/移动 live 插件目录' }, { name: hit }, hit, reason);
  return reason;
}

/** Resolve the source directory an install/enable would make live. */
export function candidateDir(args, surfaces = liveSurfaces()) {
  const target = typeof args?.target === 'string' ? args.target.trim() : '';
  if (!target) return null;
  const literal = /^(?:link|file):(.+)$/.exec(target);
  if (literal) return path.resolve(surfaces.profileDir || '.', literal[1]);
  if (path.isAbsolute(target) || target.startsWith('.')) return path.resolve(surfaces.profileDir || process.cwd(), target);
  const bare = target.replace(/^include:/, '').replace(/^[a-z-]+:/, '');
  for (const entry of surfaces.plugins) {
    if (entry.name === bare || entry.name.endsWith(`/${bare}`) || path.basename(entry.dir) === bare) return entry.dir;
  }
  const installed = surfaces.profileDir ? path.join(surfaces.profileDir, 'node_modules', bare) : '';
  return installed && fs.existsSync(installed) ? installed : null;
}

/**
 * Async pre-execute: gate anything that puts a candidate into the running profile.
 * @returns {Promise<undefined | ReturnType<typeof denial>>}
 */
export async function preExecute(exec, options = {}) {
  const name = exec?.name;
  const args = exec?.arguments ?? {};
  const surfaces = options.surfaces ?? liveSurfaces(options.profileDir);
  const enabled = args.enabled !== false;
  const installing = name === 'plugin_manager' && (args.action === 'install_bundle' || (args.action === 'set_plugin' && enabled));
  if (!installing) return undefined;
  const dir = candidateDir(args, surfaces);
  if (!dir || !fs.existsSync(dir)) return undefined;
  let findings = [];
  try {
    findings = preflight(dir).filter((finding) => BLOCKING.has(finding.ruleId));
  } catch {
    return undefined;
  }
  if (!findings.length) return undefined;
  const [finding] = findings;
  const surface = { name: path.basename(dir) };
  const reason = blockReason({
    surface,
    finding,
    file: path.join(dir, finding.file || ''),
    action: '安装',
  });
  options.onDeny?.(finding, surface, dir, reason);
  return denial(reason, finding);
}

export const DEFENSE_DEFAULTS = { guard: true, monitorOnly: false };
export { BLOCKING };
