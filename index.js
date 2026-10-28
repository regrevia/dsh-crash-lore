/**
 * dsh-crash-lore Host plugin: on activation scan new crash artifacts, keep the compact
 * rule set as a resident prompt section, and offer tools to scan / inspect / record / preflight / heal.
 *
 * Every service read is guarded: an undeclared property read on a Cordis context throws,
 * and a plugin whose job is preventing crashes must not become one.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
import {
  MODE_LABELS,
  MODES,
  claimFeedback,
  clearHooks,
  defenseRuntime,
  defenseState,
  denialFor,
  describeStatus,
  explicitMode,
  modeOfConfig,
  normalizeMode,
  recentDenials,
  recordCheck,
  recordError,
  recordFinding,
  setHook,
  setMode,
} from './state.mjs';
import { apply as applyInstallCheck } from './install-check/index.mjs';

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

/* The live-editable mode needs a real schemastery schema, but this package is normally
 * mounted through a symlink whose realpath has no node_modules: a bare import would fail to
 * resolve and take boot down with it. Resolve through the running profile, and stay silent
 * when that fails — the mode is then only reachable through the tool, never through a crash. */
function schemaFactory() {
  const bases = [];
  if (process.env.DSH_PROFILE_DIR) bases.push(path.join(process.env.DSH_PROFILE_DIR, 'package.json'));
  bases.push(import.meta.url);
  for (const base of bases) {
    try {
      const load = createRequire(base);
      const loaded = load('@deepseek-ai/schemastery');
      const z = loaded?.default ?? loaded;
      if (z && typeof z.object === 'function' && typeof z.string === 'function') return z;
    } catch {
      /* try the next base */
    }
  }
  return undefined;
}

function makeConfig() {
  const z = schemaFactory();
  if (!z) return undefined;
  try {
    /* A live-editable field is a volatile ref: the app swaps the value in place instead of
     * restarting the plugin. Older schema packages have no such marking, and boot must not fail. */
    const mode = z.string().default('protect').description('崩溃防护模式：protect 开启，observe 仅监测，off 关闭');
    const marked = typeof mode.volatile === 'function' ? mode.volatile() : mode;
    return z.object({
      mode: marked,
      home: z.string().description('崩溃日志与规则所在目录'),
      promptChars: z.number().default(1000).description('提示词里规则的字数上限'),
      guard: z.boolean().description('旧开关，等价于 mode=off'),
      monitorOnly: z.boolean().description('旧开关，等价于 mode=observe'),
      installCheck: z.boolean().default(true).description('装插件前先跟已装的比一遍：重名、缺依赖、版本、skill 撞车'),
    });
  } catch {
    return undefined;
  }
}

export const Config = makeConfig();

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

  /* One live object per process, so a hot reload keeps the denial history and the
   * "already told the origin session" ledger instead of resetting them. */
  const state = defenseRuntime();
  state.override = null;
  setMode(state, modeOfConfig(config));
  clearHooks(state);

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
    clearHooks(state);
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
      const incidents = readIncidents(home);
      if (!result.harvested) {
        /* Nothing unparsed this call, but a boot scan may already have logged the last crash;
         * saying only "没有新的崩溃日志" hides that the machine just died. Show the newest row. */
        const newest = [...incidents].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
        lines.push(newest ? `没有未解析的日志。最近一条：${summarizeIncident(newest)}（证据 ${newest.artifact}）` : '没有新的崩溃日志。');
      }
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
        total: incidents.length,
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
   * Three layers stay separate on purpose: the user's mode (开启 / 仅监测 / 关闭), what the
   * DSH actually wired (正常 / 部分覆盖 / 不可用 / 检查异常), and what the last check did
   * (放行 / 观察到风险 / 已阻止). Only the first is a choice; the other two are read from
   * reality, so a missing interface can never be reported as 保护中.
   * Two host mechanisms carry the refusal: a sync `tools.guard()` for text a write/edit
   * would put into a file the running host loads, and the async `tools/pre-execute`
   * waterfall for installs/enables, where the whole candidate can be preflighted.
   * Both fail open: a defense plugin must not become the crash. */
  const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
  let surfaces;
  try {
    surfaces = liveSurfaces(profileDir);
  } catch (error) {
    recordError(state, error);
    surfaces = { profileDir, plugins: [], patchFile: '', pkgFile: '' };
  }
  const targetLabel = (surface, file) => (surface?.name && surface.name !== 'profile' ? `${surface.name} · ${file}` : String(file ?? 'profile'));

  /* Read the mode from the config the fiber currently holds, not from the closure: a live
   * config edit and a restart both have to be visible to hooks registered earlier. */
  const liveMode = () => {
    let current = null;
    try {
      const fiber = propOf(ctx, 'fiber');
      current = fiber && typeof fiber === 'object' ? fiber.config : null;
    } catch {
      current = null;
    }
    const fromFiber = current && typeof current === 'object' ? explicitMode(current) : null;
    if (fromFiber) return fromFiber;
    if (state.override && MODES.includes(state.override)) return normalizeMode(state.override, state.mode);
    const fromClosure = explicitMode(config);
    return fromClosure ?? normalizeMode(modeOfConfig(config), state.mode);
  };

  const record = (finding, surface, file, reason, verdict, callId) => {
    const target = targetLabel(surface, file);
    const done = recordFinding(state, {
      callId,
      rule: finding?.ruleId ?? finding?.rule,
      title: finding?.title,
      target,
      reason,
    }, verdict);
    if (!done.duplicate) log(`崩溃防护${verdict === 'observe' ? '发现风险' : '拦截'} ${done.entry.rule} @ ${target}`);
    return done;
  };

  /* Hooks follow the live mode, not the value read once at apply() time. A config write can
   * commit between apply() and the first tool call, and a card that reports 开启 while no hook
   * exists is worse than having no card. Installing is idempotent; turning the defense off
   * really takes the hooks back out instead of leaving dormant ones behind. */
  const hookDisposers = [];
  /* A hook can be taken back out by a mode change and again by plugin unload; both paths run
   * the same idempotent wrapper so the second call never touches a disposed hook. */
  const track = (disposer) => {
    if (typeof disposer !== 'function') return () => {};
    let used = false;
    const call = () => {
      if (used) return;
      used = true;
      disposer();
    };
    hookDisposers.push(call);
    return call;
  };

  const installHooks = () => {
    if (state.hooks.write || state.hooks.preExecute) return;

    if (typeof tools.guard === 'function') {
      ctx.effect(() => {
        const disposer = tools.guard((exec) => {
          try {
            const mode = liveMode();
            if (mode === 'off') return undefined;
            const onDeny = (finding, surface, file, reason) => {
              record(finding, surface, file, reason, mode === 'observe' ? 'observe' : 'deny', exec?.callId);
            };
            const outcome = guardWrite(exec, { surfaces, onDeny }) ?? guardShell(exec, { surfaces, onDeny });
            const target = exec?.arguments?.path ?? exec?.arguments?.file ?? exec?.arguments?.target;
            if (!outcome && typeof target === 'string' && target) recordCheck(state, { target: targetLabel(null, target) });
            return mode === 'observe' ? undefined : outcome;
          } catch (error) {
            recordError(state, error);
            return undefined;
          }
        });
        return track(disposer);
      }, 'crash-lore: write guard');
      setHook(state, 'write', 'sync');
    } else {
      log('本机没有写前守卫接口，这一层没接上');
    }

    if (typeof ctx.on === 'function') {
      ctx.effect(() => {
        const disposer = ctx.on('tools/pre-execute', async (exec, next) => {
          try {
            const mode = liveMode();
            if (mode === 'off') return next();
            const decision = await preExecute(exec, {
              surfaces,
              profileDir,
              onDeny: (finding, surface, file, reason) => {
                record(finding, surface, file, reason, mode === 'observe' ? 'observe' : 'deny', exec?.callId);
              },
            });
            if (decision && mode !== 'observe') return decision;
            if (!decision && exec?.name === 'plugin_manager') recordCheck(state, { target: targetLabel(null, exec?.arguments?.target) });
          } catch (error) {
            recordError(state, error);
          }
          return next();
        });
        return track(disposer);
      }, 'crash-lore: install guard');
      setHook(state, 'preExecute', 'async');
    } else {
      log('本机没有安装前预检接口，这一层没接上');
    }
  };

  const removeHooks = () => {
    while (hookDisposers.length) {
      const disposer = hookDisposers.pop();
      try {
        disposer();
      } catch (error) {
        recordError(state, error);
      }
    }
    clearHooks(state);
  };

  if (state.mode === 'off') removeHooks();
  else installHooks();

  /* ---- feedback to the originating session -----------------------------------------
   * A PTC subcall's denied result is swallowed by run_code, so the agent that asked for it
   * never sees why. Hand the reason back as one supplemental context on the same session,
   * keyed by the subcall id: a re-dump of the same denial is never delivered twice, nothing
   * is broadcast, and the session keeps running. */
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!result?.isError) return next();
        const callId = exec?.callId ? String(exec.callId) : '';
        const rootId = exec?.rootCallId ? String(exec.rootCallId) : callId;
        if (!callId || rootId === callId) return next();
        const entry = denialFor(state, callId);
        if (!entry || !claimFeedback(state, callId)) return next();
        const step = String(exec?.name ?? '子调用');
        const target = [exec?.arguments?.target, exec?.arguments?.path, exec?.arguments?.file, entry.target]
          .map((value) => (typeof value === 'string' ? value : ''))
          .find(Boolean) ?? '';
        const text = [
          `崩溃防线阻止了一次子调用（${step}）。会话可以继续。`,
          `规则 ${entry.rule}${entry.title ? `：${entry.title}` : ''}`,
          `原因：${entry.reason || entry.title || '目标文件会被下一次启动加载，写坏会让宿主起不来'}`,
          `未执行：${step}${target ? ` → ${target}` : ''}`,
          '改法：按上面的原因改掉再重试这一步；哪条规则不清楚就先跑 crash_lore_check 看致命项。',
        ].join('\n');
        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'ptc-mode' },
        };
        return { kind: 'accept', additionalContexts: [message] };
      } catch (error) {
        recordError(state, error);
        return next();
      }
    }), 'crash-lore: ptc feedback');
  }

  /* 静态安装体检：装之前跟已装的比一遍（只加备注，不拦安装）。关掉防御时一并关闭。 */
  if (config.installCheck !== false && modeOfConfig(config) !== 'off') {
    ctx.effect(() => applyInstallCheck(ctx), 'crash-lore: install check');
  }

  /* Mode is the only writable knob, and it is written through the DSH config editor, so
   * the choice lands in the profile patch DSH itself owns: no config pass-through, no
   * hand-edited file, and an unchanged value leaves no row behind. */
  const persistMode = async (value) => {
    if (!MODES.includes(value)) return '模式只认 protect / observe / off，这一项没有保存';
    const editor = serviceOf(ctx, 'configEditor');
    if (!editor || typeof editor.configuration !== 'function' || typeof editor.edit !== 'function') {
      return '本机没有提供配置接口，模式没有保存';
    }
    let rows = [];
    try {
      rows = editor.configuration();
    } catch (error) {
      recordError(state, error);
      return '读配置入口失败，模式没有保存';
    }
    const row = Array.isArray(rows)
      ? rows.find((item) => item?.entry?.options?.name === name || item?.entry?.options?.id === 'crash-lore')
      : null;
    if (!row) return 'profile 里找不到这个插件的配置入口，模式没有保存';
    try {
      await editor.edit(row.entry, (current) => {
        const next = current && typeof current === 'object' ? { ...current } : {};
        delete next.guard;
        delete next.monitorOnly;
        next.mode = value;
        return next;
      });
    } catch (error) {
      recordError(state, error);
      return `模式没有保存：${error?.message ?? error}`;
    }
    state.override = value;
    setMode(state, value);
    return `模式已切到 ${MODE_LABELS[value]}`;
  };

  ctx.effect(() => tools.register(withOutput({
    name: 'crash_lore_guard',
    description: '看崩溃防护现在是什么模式、DSH 实际接上了哪几层检查、最近一次检查和拒绝记录。传 mode 可以把防护切成 开启 / 仅监测 / 关闭，写进配置，刷新和重启后保留。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最近几条拒绝记录，默认 5' },
        mode: { type: 'string', enum: ['protect', 'observe', 'off'], description: 'protect 开启，observe 仅监测，off 关闭' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
      const note = typeof args?.mode === 'string' ? await persistMode(args.mode) : null;
      /* The mode can also change through a config write that does not restart the plugin, so the
       * card re-reads it instead of trusting whatever the last apply() saw. */
      setMode(state, liveMode());
      /* Keep the hooks and the mode in step even when the value changed without a restart. */
      if (state.mode === 'off') removeHooks();
      else installHooks();
      const info = defenseState();
      const lines = describeStatus();
      const recent = recentDenials(state, limit);
      if (recent.length) {
        lines.push(`最近拒绝 ${recent.length} 条`);
        for (const entry of recent) lines.push(`- ${entry.at} ${entry.rule} ${entry.title} → ${entry.target}`);
      } else if (info.capability !== 'off') {
        lines.push('最近没有拒绝记录');
      }
      lines.push('覆盖不到：命令行直接写文件、外部编辑器保存、DSH 自身升级。');
      if (note) lines.push(note);
      return { text: lines.join('\n'), ...info, denials: recent, note };
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
