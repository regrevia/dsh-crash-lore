/**
 * dsh-crash-lore Host plugin: on activation scan new crash artifacts, keep the compact
 * rule set as a resident prompt section, and offer tools to scan / inspect / record / preflight / heal.
 *
 * Every service read is guarded: an undeclared property read on a Cordis context throws,
 * and a plugin whose job is preventing crashes must not become one.
 */
import path from 'node:path';
import {
  DEFAULT_HOME,
  readIncidents,
  readRules,
  readState,
  scan,
  compactRules,
  renderLorePrompt,
  summarizeIncident,
  upsertRule,
  seedRules,
  importCorpus,
  PROMPT_HEADER,
} from './core.mjs';
import { guardWrite, guardShell, preExecute, liveSurfaces } from './defense.mjs';

export const name = 'dsh-crash-lore';
/* Harness ≥ the 2026-09 tool contract: every tool must declare an output shape and a renderer.
 * Keep the payload object and render its `text` field. */
const TOOL_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

function withOutput(tool) {
  const execute = tool.execute;
  return {
    ...tool,
    output: TOOL_OUTPUT,
    execute: async (...rest) => {
      const value = await execute(...rest);
      return typeof value === 'string' ? { text: value } : { ...value, text: String(value?.text ?? '') };
    },
  };
}

export const inject = ['tools'];

function propOf(target, key) {
  try {
    return target?.[key];
  } catch {
    return undefined;
  }
}

function serviceOf(ctx, key) {
  const direct = propOf(ctx, key);
  if (direct !== undefined && direct !== null) return direct;
  const get = propOf(ctx, 'get');
  try {
    const value = typeof get === 'function' ? get.call(ctx, key) : undefined;
    return value ?? null;
  } catch {
    return null;
  }
}

function log(message) {
  try {
    console.log(`[crash-lore] ${message}`);
  } catch {
    /* console gone during shutdown */
  }
}

export function apply(ctx, config = {}) {
  const home = typeof config.home === 'string' && config.home ? config.home : DEFAULT_HOME;
  const promptBudget = Number.isFinite(config.promptChars) ? Math.max(300, Math.min(2000, config.promptChars)) : 1000;

  /* Boot scan: never throws, never blocks activation. A crash during the last run left an
   * artifact on disk; this is the boot where it gets turned into lore. */
  let lastScan = { at: 0, added: [], unknown: [], error: null };
  ctx.effect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => {
        /* First boot on a fresh profile: ship the checked-in rules, then import the corpus. */
        if (!readRules(home).length) seedRules(home);
        importCorpus(home);
        return scan({ home });
      })
      .then((result) => {
        if (!alive) return;
        lastScan = { at: Date.now(), added: result.added, unknown: result.unknown, error: null };
        if (result.added.length) {
          log(`新崩溃 ${result.added.length} 条：${result.added.map(summarizeIncident).join('；')}`);
        }
        if (result.unknown.length) log(`有 ${result.unknown.length} 条崩溃没有对应规则，用 crash_lore_record 补一条`);
      })
      .catch((error) => {
        lastScan = { at: Date.now(), added: [], unknown: [], error: String(error?.message ?? error) };
        log(`扫描失败：${error?.message ?? error}`);
      });
    return () => {
      alive = false;
    };
  }, 'crash-lore: boot scan');

  /* Resident section: the compact lore, re-read on every step so a rule recorded mid-session
   * takes effect without a restart. */
  const prompt = serviceOf(ctx, 'systemPrompt');
  if (prompt && typeof prompt.context === 'function') {
    ctx.effect(() => prompt.context({
      name: 'crash-lore: rules',
      order: 42,
      interpolate: false,
      required: false,
      text: () => {
        try {
          const rules = readRules(home);
          return renderLorePrompt(rules, { maxChars: promptBudget });
        } catch {
          return '';
        }
      },
    }), 'crash-lore: prompt section');
  }

  const tools = serviceOf(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') {
    log('没有 tools 服务，本次只做扫描和提示词注入');
    return;
  }

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_scan',
    description: '扫描本机新的 DSH 崩溃日志（宿主崩溃、web 启动失败、启动诊断），转成条目并按已知规则归因；返回这次新增的崩溃和还没有规则的未知项。发现 harness 崩过、或怀疑某个插件把进程搞死时先调它。',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: '连已扫过的日志也重新解析' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = scan({ home, force: args?.force === true });
      const lines = [];
      if (!result.harvested) lines.push('没有新的崩溃日志。');
      for (const incident of result.added) {
        const rule = incident.ruleIds?.length ? ` 已知规则 ${incident.ruleIds.join(',')}` : ' 无对应规则';
        lines.push(`- ${summarizeIncident(incident)}${rule}`);
        lines.push(`  证据 ${incident.artifact}`);
      }
      if (!result.added.length && result.harvested) lines.push(`解析了 ${result.harvested} 个日志，没有新条目（与已有条目重复）。`);
      if (result.unknown.length) lines.push('未知形态先调 crash_lore_record 补规则，再调 crash_lore_export 写进长期记忆。');
      return {
        text: lines.join('\n'),
        added: result.added.length,
        unknown: result.unknown.length,
        total: readIncidents(home).length,
      };
    },
  })), 'crash-lore: crash_lore_scan');

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_rules',
    description: '查本机沉淀的 DSH 崩溃规则（标题 / 成因 / 改法 / 命中次数）。写插件、改 profile 配置前先查一遍要遵守什么。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按关键词过滤，例如 activate、config、client' },
        limit: { type: 'integer', description: '最多几条，默认 20' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const rules = compactRules(readRules(home), { query: args?.query, limit: Math.max(1, Math.min(60, Number(args?.limit) || 20)) });
      if (!rules.length) return { text: '还没有规则。先 crash_lore_scan 扫日志。', rules: [] };
      const lines = rules.map((rule) => `[${rule.id}] ${rule.title}${rule.severity === 'fatal' ? '（致命）' : rule.severity === 'boot' ? '（阻断启动）' : ''} 命中${rule.hits}\n  成因 ${rule.cause}\n  改法 ${rule.fix}`);
      return { text: lines.join('\n'), rules };
    },
  })), 'crash-lore: crash_lore_rules');

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_record',
    description: '把一次崩溃或一条踩坑经验沉淀成规则（标题 + 成因 + 改法 + 可选静态守卫），写进本机规则库，下一步起生效。修完导致崩溃的插件后调用，把这次的教训留下。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话命令式约束，≤40 字，例如「事件回调里不要抛未捕获异常」' },
        cause: { type: 'string', description: '触发原因，≤120 字' },
        fix: { type: 'string', description: '怎么改，≤120 字' },
        signature: { type: 'string', description: '匹配崩溃信息的正则；不写则按标题去重更新' },
        severity: { type: 'string', enum: ['fatal', 'boot', 'lint'], description: 'fatal 杀进程 / boot 阻断启动 / lint 局部异常' },
        guardPattern: { type: 'string', description: '可选：能在插件源码里静态命中的正则，用于 crash_lore_check 预检' },
        guardMessage: { type: 'string', description: '命中守卫时给作者看的一句话' },
        evidence: { type: 'string', description: '证据：日志路径或现象描述' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const guard = args?.guardPattern
        ? { kind: 'source-regex', pattern: String(args.guardPattern), message: String(args.guardMessage ?? args.cause ?? args.title) }
        : null;
      if (guard) {
        try {
          new RegExp(guard.pattern, 'i');
        } catch {
          return { text: `守卫正则无效，未写入：${guard.pattern}` };
        }
      }
      const rule = upsertRule({
        title: String(args.title).slice(0, 40),
        cause: String(args.cause ?? '').slice(0, 120),
        fix: String(args.fix ?? '').slice(0, 120),
        signature: args.signature ? String(args.signature) : '',
        severity: ['fatal', 'boot', 'lint'].includes(args.severity) ? args.severity : 'lint',
        guard,
        tags: args.evidence ? [String(args.evidence).slice(0, 80)] : [],
      }, home);
      return { text: `已记下 [${rule.id}] ${rule.title}；下一步起出现在提示词里。同步长期记忆用 crash_lore_export。`, rule };
    },
  })), 'crash-lore: crash_lore_record');

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_check',
    description: '安装前静态预检插件源码目录（不执行代码）：先按 loader 的真实要求检查包结构、patch、工具注册契约、ESM 语法，再套本机崩溃规则。改完插件、准备装进 profile 前调它；有 fatal/boot 就是装上去会崩。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '插件源码目录绝对路径' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const dir = String(args?.dir ?? '');
      if (!path.isAbsolute(dir)) return { text: '需要绝对路径。' };
      const { checkSource, preflight, renderAll } = await import('./guard.mjs');
      const findings = [...preflight(dir), ...checkSource(dir, readRules(home))];
      const blocking = findings.filter((item) => item.severity === 'fatal' || item.severity === 'boot').length;
      return { text: renderAll(findings, dir), findings: findings.length, blocking };
    },
  })), 'crash-lore: crash_lore_check');

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_export',
    description: '把本机崩溃规则导出：memory 写进 dsh-lite-memory 长期记忆（跨会话、按标题更新），markdown 输出一段精简清单。规则稳定后调一次。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['markdown', 'memory'], description: '默认 markdown：只在对话里给清单；memory 才写长期记忆（会进召回，慎用）' },
        dryRun: { type: 'boolean', description: '只演练不写盘' },
        scope: { type: 'string', enum: ['global', 'project'], description: '默认 global：崩溃约束跨项目通用；project 只在当前项目可见' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const rules = readRules(home);
      if (!rules.length) return { text: '还没有规则可导出。' };
      const target = args?.target === 'memory' ? 'memory' : 'markdown';
      const mod = await import('./memory.mjs').catch(() => null);
      if (!mod) return { text: '缺少 memory.mjs，导出暂不可用。' };
      if (target === 'markdown') {
        return { text: mod.exportMarkdown(rules, { home, projectDir: process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop') }) };
      }
      const dryRun = args?.dryRun === true;
      const scope = args?.scope === 'project' ? 'project' : 'global';
      const result = await mod.exportRules(rules, { home, dryRun, scope, projectDir: process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop') });
      const written = result?.exported?.length ?? 0;
      return {
        text: dryRun ? `演练：会写入 ${written} 条到长期记忆，未改动。` : `已写入 ${written} 条到长期记忆。`,
        result,
      };
    },
  })), 'crash-lore: crash_lore_export');

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_heal',
    description: '当 harness 起不来时用的自愈：找出最近一次致命崩溃的元凶插件并给停用计划。apply=true 直接停用；auto=true 只在确认是崩溃循环（24h 内同元凶 ≥3 次）时才停用，否则只报告。改动前备份，可 doctor --restore 撤销，重启 harness 生效。',
    parameters: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: '真的执行停用；不写只给计划' },
        auto: { type: 'boolean', description: '仅在确认是崩溃循环（24h 内同元凶 ≥3 次）时自动停用，否则只给结果' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const mod = await import('./doctor.mjs').catch(() => null);
      if (!mod) return { text: '缺少 doctor.mjs，自愈暂不可用。' };
      const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
      const result = mod.runDoctor({ home, profileDir, yes: args?.apply === true, auto: args?.auto === true });
      const lines = [...(result?.lines ?? [])];
      if (result?.conclusion) lines.push(result.conclusion);
      return { text: lines.length ? lines.join('\n') : '没有找到可停用的元凶。', result };
    },
  })), 'crash-lore: crash_lore_heal');

  /* ---- live defense ----------------------------------------------------------------
   * Two host mechanisms carry the refusal: a sync `tools.guard()` for text a write/edit
   * would put into a file the running host loads, and the async `tools/pre-execute`
   * waterfall for installs/enables, where the whole candidate can be preflighted.
   * Both fail open: a defense plugin must not become the crash. */
  const defense = {
    enabled: config.guard !== false,
    monitorOnly: config.monitorOnly === true,
    hooks: { write: null, preExecute: null },
    denials: [],
    lastError: null,
  };
  const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
  const surfaces = liveSurfaces(profileDir);
  const targetLabel = (surface, file) => (surface?.name && surface.name !== 'profile' ? `${surface.name} · ${file}` : String(file ?? 'profile'));
  const record = (finding, surface, file, reason) => {
    defense.denials.push({
      at: new Date().toISOString(),
      rule: finding?.ruleId ?? '?',
      title: finding?.title ?? '',
      target: targetLabel(surface, file),
      reason,
    });
    if (defense.denials.length > 20) defense.denials.shift();
    log(`崩溃防护拦截 ${finding?.ruleId ?? '?'} @ ${targetLabel(surface, file)}`);
  };

  if (defense.enabled) {
    if (typeof tools.guard === 'function' && !defense.monitorOnly) {
      ctx.effect(() => tools.guard((exec) => {
        try {
          return guardWrite(exec, { surfaces, onDeny: record }) ?? guardShell(exec, { surfaces, onDeny: record });
        } catch (error) {
          defense.lastError = String(error?.message ?? error);
          return undefined;
        }
      }), 'crash-lore: write guard');
      defense.hooks.write = 'sync';
    }
    if (typeof ctx.on === 'function') {
      ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          const decision = await preExecute(exec, { surfaces, profileDir, onDeny: record });
          if (decision) {
            if (defense.monitorOnly) record({ ruleId: decision.info?.rule, title: decision.info?.title }, { name: String(exec?.arguments?.target ?? '') }, exec?.arguments?.target ?? '', decision.reason);
            else return decision;
          }
        } catch (error) {
          defense.lastError = String(error?.message ?? error);
        }
        return next();
      }), 'crash-lore: install guard');
      defense.hooks.preExecute = 'async';
    }
  }

  const guardMode = () => {
    if (!defense.enabled) return '已关闭';
    if (defense.lastError) return '检查异常';
    if (defense.monitorOnly || (!defense.hooks.write && !defense.hooks.preExecute)) return '仅监测';
    if (!defense.hooks.write || !defense.hooks.preExecute) return '部分覆盖';
    return '保护中';
  };

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_guard',
    description: '看崩溃防护自身的状态和最近的拦截记录：现在能拦什么、哪一层没接上（仅监测/部分覆盖）、最近拒绝了哪个改动和原因。怀疑某次改动被拦、或想知道防护是否真的生效时调它。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最近几条拦截，默认 5' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
      const lines = [`状态：${guardMode()}`];
      lines.push(`开关：崩溃防护${defense.enabled ? '开启' : '关闭'}${defense.monitorOnly ? '，仅监测（只记录不拦）' : ''}`);
      lines.push(`写前守卫（同步）：${defense.hooks.write === 'sync' ? '已接上，write/edit 改动 live 插件或 profile 配置时检查目标文本' : '未接上'}`);
      lines.push(`安装前预检（异步）：${defense.hooks.preExecute === 'async' ? '已接上，plugin_manager 安装/启用前预检候选目录' : '未接上'}`);
      if (defense.lastError) lines.push(`最近一次检查异常：${defense.lastError}`);
      lines.push('未覆盖：bash/脚本里直接写文件、run_code 里自己 fs 写盘、外部编辑器保存、宿主自身升级。');
      const recent = defense.denials.slice(-limit).reverse();
      if (!recent.length) lines.push('最近没有拦截记录。');
      for (const entry of recent) lines.push(`- ${entry.at} ${entry.rule} ${entry.title} → ${entry.target}`);
      return { text: lines.join('\n'), mode: guardMode(), enabled: defense.enabled, monitorOnly: defense.monitorOnly, hooks: { ...defense.hooks }, denials: recent };
    },
  })), 'crash-lore: crash_lore_guard');

  /* Surface the newest unresolved incident once per session, so an agent knows *why* the
   * previous run died without being told. */
  ctx.effect(() => {
    const rules = readRules(home);
    const incidents = readIncidents(home);
    const last = incidents[incidents.length - 1];
    if (!last) return () => {};
    const state = readState(home);
    const quarantined = new Set((state.quarantine ?? []).map((entry) => entry.name));
    if (last.culprit?.name && quarantined.has(last.culprit.name)) return () => {};
    log(`最近一次崩溃：${summarizeIncident(last)}（${last.ts}）`);
    return () => {};
  }, 'crash-lore: last incident log');

  return { scan: () => lastScan, header: PROMPT_HEADER };
}
