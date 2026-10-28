#!/usr/bin/env node
/**
 * crash-lore CLI: works with plain node, outside DSH — this is the path you take when
 * the harness itself will not start.
 *
 *   node cli.mjs scan                 # harvest new crash artifacts
 *   node cli.mjs rules [--json] [q]   # the compact lore
 *   node cli.mjs prompt [--chars 900] # exactly what the agent sees resident
 *   node cli.mjs check <pluginDir>    # static preflight against known crash shapes
 *   node cli.mjs export [--md] [--dry-run]
 *   node cli.mjs doctor [--yes|--auto] # plan (default), disable, or auto only on a crash loop
 *   node cli.mjs restore <name>       # undo a doctor quarantine
 */
import path from 'node:path';
import {
  DEFAULT_HOME,
  fetchArtifacts,
  paths,
  readIncidents,
  readRules,
  readState,
  renderLorePrompt,
  seedRules,
  writeRules,
  importCorpus,
  scan,
  summarizeIncident,
  compactRules,
} from './core.mjs';
import { checkSource, preflight, renderAll } from './guard.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = argv.slice(1).filter((arg) => !arg.startsWith('--'));
const get = (flag, fallback) => {
  const at = argv.findIndex((arg) => arg === `--${flag}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};

const home = process.env.DSH_HOME || DEFAULT_HOME;
const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');

function print(text) {
  process.stdout.write(`${text}\n`);
}

function help() {
  print(`crash-lore — 本机 DSH 崩溃日志沉淀成约束

  seed                 导入随包规则（rules.seed.json）
  scan                 扫描新的崩溃日志并归因
  rules [q] [--json]   列出规则（标题/成因/改法）
  prompt [--chars N]   输出注入提示词的那段正文
  check <插件目录>      安装前静态预检
  export [--md] [--dry-run] [--memory]
  doctor [--yes]       找出元凶并停用（默认只给计划）
  doctor --auto        仅在确认是崩溃循环（24h 内同元凶 ≥3 次）时自动停用
  restore <包名>        撤销 doctor 的停用

存储：${paths(home).dir}`);
}

switch (cmd) {
  case 'scan': {
    const result = scan({ home, force: flags.has('--force') });
    print(`解析 ${result.harvested} 个新日志，新增 ${result.added.length} 条，未知 ${result.unknown.length} 条，规则 ${result.rules} 条。`);
    for (const incident of result.added) print(`- ${summarizeIncident(incident)}\n  ${incident.artifact}`);
    if (result.unknown.length) print('未知形态需要补规则（先看 rules.json，或让 agent 用 crash_lore_record）。');
    break;
  }
  case 'rules': {
    const rules = compactRules(readRules(home), { query: positional[0] ?? '', limit: Number(get('limit', '40')) });
    if (flags.has('--json')) print(JSON.stringify(rules, null, 2));
    else if (!rules.length) print('还没有规则。先 scan。');
    else for (const rule of rules) print(`[${rule.id}] ${rule.title}  (${rule.severity}, 命中${rule.hits})\n  成因 ${rule.cause}\n  改法 ${rule.fix}`);
    break;
  }
  case 'prompt': {
    const text = renderLorePrompt(readRules(home), { maxChars: Number(get('chars', '1000')) });
    print(text || '（提示词为空：还没有规则）');
    print(`\n—— ${text.length} 字符`);
    break;
  }
  case 'check': {
    const dir = positional[0];
    if (!dir) {
      print('用法：node cli.mjs check <插件源码目录>');
      process.exitCode = 2;
      break;
    }
    const findings = [...preflight(dir), ...checkSource(dir, readRules(home))];
    print(renderAll(findings, dir));
    if (findings.length) process.exitCode = 1;
    break;
  }
  case 'export': {
    const mod = await import('./memory.mjs').catch(() => null);
    if (!mod) {
      print('缺少 memory.mjs。');
      process.exitCode = 2;
      break;
    }
    const rules = readRules(home);
    if (!flags.has('--memory')) print(mod.exportMarkdown(rules, { home, projectDir: profileDir }));
    else {
      const result = await mod.exportRules(rules, { home, dryRun: flags.has('--dry-run'), projectDir: profileDir });
      print(`${flags.has('--dry-run') ? '演练' : '已导出'} ${result?.exported?.length ?? 0} 条 → ${result?.storeDir ?? '未知位置'}`);
      if (result?.skipped?.length) print(`跳过 ${result.skipped.length} 条：${result.skipped.map((item) => `${item.ruleId} ${item.reason}`).join('，')}`);
      /* Write the memory id back so a later export can tell "already there" from "gone". */
      if (!flags.has('--dry-run') && result?.exported?.length) {
        const byRule = new Map(result.exported.map((item) => [item.ruleId, item.memoryId]));
        let touched = 0;
        for (const rule of rules) {
          const id = byRule.get(rule.id);
          if (id && rule.memoryId !== id) {
            rule.memoryId = id;
            touched += 1;
          }
        }
        if (touched) writeRules(rules, home);
      }
    }
    break;
  }
  case 'doctor': {
    const mod = await import('./doctor.mjs').catch(() => null);
    if (!mod) {
      print('缺少 doctor.mjs。');
      process.exitCode = 2;
      break;
    }
    const result = mod.runDoctor({ home, profileDir, yes: flags.has('--yes'), auto: flags.has('--auto') });
    for (const line of result?.lines ?? []) print(line);
    if (result?.conclusion) print(result.conclusion);
    break;
  }
  case 'restore': {
    const mod = await import('./doctor.mjs').catch(() => null);
    const name = positional[0];
    if (!mod || !name) {
      print('用法：node cli.mjs restore <包名>');
      process.exitCode = 2;
      break;
    }
    const result = mod.runRestore(name, { home, profileDir });
    for (const line of result?.lines ?? []) print(line);
    if (result?.message) print(result.message);
    break;
  }
  case 'seed': {
    const result = seedRules(home);
    const corpus = importCorpus(home);
    print(`种子规则导入：新增 ${result.seeded} 条，共 ${result.total} 条；样例条目补入 ${corpus.imported} 条。`);
    break;
  }
  case 'artifacts': {
    for (const artifact of fetchArtifacts(home)) print(`${artifact.source}\t${new Date(artifact.mtimeMs).toISOString()}\t${artifact.path}`);
    break;
  }
  case 'status': {
    const state = readState(home);
    print(`规则 ${readRules(home).length} 条 · 条目 ${readIncidents(home).length} 条 · 已扫日志 ${Object.keys(state.scanned ?? {}).length} 个 · 停用记录 ${(state.quarantine ?? []).length} 条`);
    break;
  }
  default:
    help();
}
