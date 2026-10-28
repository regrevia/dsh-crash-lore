/**
 * dsh-crash-lore doctor: 崩溃后把真凶插件从 profile 里安全摘掉。
 *
 * 纯 Node、零依赖、import 无副作用。被 cli.mjs 的 `doctor` 子命令调用：
 *
 *   import { runDoctor, runRestore } from './doctor.mjs';
 *   runDoctor({ home, profileDir, yes, dryRun });
 *   runRestore(name, { home, profileDir, dryRun });
 *
 * 安全边界：
 * - 默认（没有 --yes）只打印计划，一个字节都不写；dryRun 由调用方显式传也成立。
 * - 写入前把 package.json / cordis.patch.yml 备份成 *.bak-doctor-<ts>；
 * - cordis.patch.yml 只给「id/name 指向真凶」的 YAML 条目整块加 `# `，
 *   其余行逐字节保留；文件结构看不懂（Tab 缩进、会切成空文档）就整体放弃，
 *   绝不半写；
 * - 隔离记录追加到 $DSH_HOME/crash-lore/state.json 的 quarantine，
 *   保留 scanned 等其它键（走 core.readState/writeState）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readIncidents, readState, writeState } from './core.mjs';

const CULPRIT_TYPES = new Set(['plugin', 'package']);
const PATCH_FILE = 'cordis.patch.yml';
const PKG_FILE = 'package.json';

function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function defaultProfileDir() {
  return process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1)).trim()}…`;
}

/* ------------------------------------------------------- culprit / profile */

/**
 * 一个字符串（依赖 spec / patch 里的 id、name）是否指向这个包名。
 * 覆盖：裸包名、link:/file: 路径、file:///.../index.js、相对目录。
 */
export function refersTo(value, name) {
  const target = String(name ?? '').trim();
  const raw = String(value ?? '').trim();
  if (!target || !raw) return false;
  if (raw === target) return true;
  const spec = raw.replace(/^(?:link|file):/, '').replace(/^file:\/\//, '');
  if (spec === target) return true;
  const segments = spec.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return false;
  if (segments.includes(target)) return true;
  const base = segments[segments.length - 1].replace(/\.(?:c?js|mjs|ts|json)$/i, '');
  if (base === target) return true;
  if (segments.length >= 2 && segments[segments.length - 2] === target) return true;
  // 作用域包（@scope/pkg）在路径里本身带一个斜杠
  if (target.includes('/') && raw.replace(/^file:\/\//, '').endsWith(`/${target}`)) return true;
  return false;
}

/** 在 profile 里定位真凶：依赖键、bundles 里的名字、patch 文件。 */
export function findCulprit(profileDir, name) {
  const pkgFile = path.join(profileDir, PKG_FILE);
  const pkg = readJsonFile(pkgFile);
  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, reason: 'profile_unreadable', message: `读不到 ${pkgFile}，不动任何文件` };
  }
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const depKey = Object.keys(deps).find((key) => key === name || refersTo(deps[key], name)) || null;
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const bundleKeys = bundles.filter((item) => item === name || refersTo(item, name));
  const patchFile = path.join(profileDir, PATCH_FILE);
  const patchText = readText(patchFile);
  const patch = patchText == null ? null : analyzePatch(patchText);
  const patchBlocks = patch && patch.ok ? patch.blocks.filter((block) => blockRefersTo(block, name)) : [];
  const patchMentions = patchText != null && String(patchText).includes(name);
  return { ok: true, pkgFile, pkg, depKey, depSpec: depKey ? String(deps[depKey]) : null, bundles, bundleKeys, patchFile, patchText, patch, patchBlocks, patchMentions };
}

/* ------------------------------------------------------------- patch YAML */

function yamlScalar(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/\s+#.*$/, '');
  if (!text) return '';
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2];
  return text.trim();
}

const ITEM_RE = /^([ ]*)-(\s|$)/;
const KEY_RE = /^([ ]*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/**
 * 极简 YAML 条目扫描：只认「以 `- ` 开始的列表项 + 它下面的 id:/name:」。
 * 不解释 anchors、flow、多文档；看不懂就报错让调用方放弃，而不是猜。
 */
export function analyzePatch(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const blocks = [];
  const stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[ ]*\t/.test(line)) {
      return { ok: false, reason: 'tab_indent', message: `${PATCH_FILE} 第 ${i + 1} 行缩进里有 Tab，不敢改` };
    }
    const item = ITEM_RE.exec(line);
    if (item) {
      const indent = item[1].length;
      while (stack.length && indent <= stack[stack.length - 1].indent) {
        const done = stack.pop();
        done.end = Math.max(done.start + 1, i);
      }
      const block = { start: i, end: i + 1, indent, id: null, name: null, insert: false, parent: stack[stack.length - 1] || null };
      const rest = line.slice(item[0].length);
      const key = KEY_RE.exec(rest.trimStart());
      if (key) applyKey(block, key[2], key[3]);
      stack.push(block);
      blocks.push(block);
      continue;
    }
    for (const block of stack) block.end = i + 1;
    if (stack.length) {
      const top = stack[stack.length - 1];
      const key = KEY_RE.exec(line);
      if (key && key[1].length > top.indent) applyKey(top, key[2], key[3]);
    }
  }
  while (stack.length) {
    const done = stack.pop();
    done.end = Math.max(done.start + 1, lines.length);
  }
  for (const block of blocks) {
    let end = block.end;
    while (end > block.start + 1 && !lines[end - 1].trim()) end -= 1;
    block.end = end;
  }
  if (!blocks.length) return { ok: false, reason: 'not_a_list', message: `${PATCH_FILE} 不是条目数组，不敢改` };
  return { ok: true, lines, blocks };
}

function applyKey(block, key, value) {
  if (key === 'insert' && !String(value || '').trim()) block.insert = true;
  if (key === 'id' && block.id == null) block.id = yamlScalar(value);
  if (key === 'name' && block.name == null) block.name = yamlScalar(value);
}

function blockRefersTo(block, name) {
  return refersTo(block.id, name) || refersTo(block.name, name);
}

function rootOf(blocks, block) {
  let node = block;
  while (node.parent) node = node.parent;
  return node;
}

function childrenOf(blocks, block) {
  return blocks.filter((item) => item.parent === block);
}

function commentedBlock(lines, block) {
  const out = [];
  for (let i = block.start; i < block.end; i += 1) out.push(lines[i].trim() ? `# ${lines[i]}` : lines[i]);
  return out.join('\n');
}

/**
 * 注释掉引用 name 的 YAML 条目；返回新全文。结构不安全时 { ok:false }。
 * 只改这些条目的行：给非空行加 `# `，其它行原样保留。
 */
export function commentPatchEntries(text, name) {
  const analysis = analyzePatch(text);
  if (!analysis.ok) return analysis;
  const { lines, blocks } = analysis;
  const matched = blocks.filter((block) => blockRefersTo(block, name));
  if (!matched.length) return { ok: true, text, commented: [], changed: false };
  const targets = new Set();
  for (const block of matched) {
    const root = rootOf(blocks, block);
    const kids = childrenOf(blocks, root);
    if (root.insert && kids.length > 0 && kids.every((kid) => matched.includes(kid))) targets.add(root);
    else targets.add(block);
  }
  const roots = blocks.filter((block) => block.parent === null);
  if (roots.length > 0 && roots.every((root) => targets.has(root))) {
    return { ok: false, reason: 'patch_would_be_empty', message: `${PATCH_FILE} 改完会变成空文件，请手动处理` };
  }
  const ordered = [...targets].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) {
      return { ok: false, reason: 'overlapping_blocks', message: `${PATCH_FILE} 匹配条目嵌套重叠，不敢改` };
    }
  }
  const out = [...lines];
  for (const block of ordered) {
    for (let i = block.start; i < block.end; i += 1) if (lines[i].trim()) out[i] = `# ${lines[i]}`;
  }
  const result = out.join('\n');
  const after = analyzePatch(result);
  if (!after.ok) return { ok: false, reason: 'patch_would_be_empty', message: `${PATCH_FILE} 注释后不再是条目数组，不敢改` };
  const left = after.blocks.filter((block) => blockRefersTo(block, name));
  if (left.length) return { ok: false, reason: 'patch_still_referenced', message: `${PATCH_FILE} 注释后仍能扫到 ${name}，不敢改` };
  const active = after.blocks.filter((block) => block.parent === null);
  if (!active.length) return { ok: false, reason: 'patch_would_be_empty', message: `${PATCH_FILE} 改完会变成空文件，请手动处理` };
  return {
    ok: true,
    text: result,
    changed: result !== text,
    commented: ordered.map((block) => ({
      id: block.id,
      name: block.name,
      start: block.start + 1,
      end: block.end,
      text: lines.slice(block.start, block.end).join('\n'),
      commentedText: commentedBlock(lines, block),
    })),
  };
}

/** 从备份的 patch 文本中恢复被注释掉的 name 条目（精确整块替换，不猜）。 */
export function restorePatchEntries(currentText, backupText, name) {
  const backup = analyzePatch(backupText ?? '');
  if (!backup.ok) return { ok: false, reason: backup.reason, message: backup.message };
  const current = analyzePatch(currentText ?? '');
  if (!current.ok) return { ok: false, reason: current.reason, message: current.message };
  const targets = backup.blocks.filter((block) => blockRefersTo(block, name));
  let text = currentText;
  let restored = 0;
  for (const block of targets) {
    const raw = backup.lines.slice(block.start, block.end).join('\n');
    const commented = commentedBlock(backup.lines, block);
    if (commented === raw) continue;
    if (text.includes(commented)) {
      text = text.replace(commented, raw);
      restored += 1;
    }
  }
  return { ok: true, text, restored, changed: text !== currentText };
}

/* ---------------------------------------------------------------- doctor */

function candidates(incidents, state) {
  const quarantined = new Set((state.quarantine || []).map((entry) => String(entry?.name ?? '')).filter(Boolean));
  return incidents
    .filter((incident) => incident && incident.culprit && CULPRIT_TYPES.has(incident.culprit.type) && String(incident.culprit.name ?? '').trim())
    .filter((incident) => !quarantined.has(incident.culprit.name))
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
}

function backupPath(file, at) {
  return `${file}.bak-doctor-${at}`;
}

/** 算出完整计划；不改任何文件（dryRun 与真跑共用）。 */
export function planDoctor(options = {}) {
  const home = path.resolve(options.home || defaultHome());
  const profileDir = path.resolve(options.profileDir || defaultProfileDir());
  const incidents = readIncidents(home);
  const state = readState(home);
  const ordered = candidates(incidents, state);
  if (!ordered.length) {
    return { ok: true, action: 'none', changed: false, home, profileDir, incident: null, plan: null, reason: 'no_candidate', message: '没有待隔离的插件/包崩溃（或都已隔离过）' };
  }
  let found = null;
  for (const incident of ordered) {
    const culprit = findCulprit(profileDir, incident.culprit.name);
    if (!culprit.ok) return { ok: false, action: 'none', changed: false, home, profileDir, incident, reason: culprit.reason, message: culprit.message };
    const actionable = Boolean(culprit.depKey || culprit.bundleKeys.length || culprit.patchBlocks.length || (culprit.patchText != null && !culprit.patch.ok && culprit.patchMentions));
    if (!actionable) continue;
    found = { incident, culprit };
    break;
  }
  if (!found) {
    return {
      ok: true,
      action: 'none',
      changed: false,
      home,
      profileDir,
      incident: ordered[0],
      reason: 'not_in_profile',
      message: `${ordered[0].culprit.name} 在 profile 的依赖/bundles/patch 里都找不到，没什么可摘的`,
    };
  }
  const { incident, culprit } = found;
  const name = incident.culprit.name;
  const at = stamp();
  if (culprit.patchText != null && !culprit.patch.ok) {
    return { ok: false, action: 'none', changed: false, home, profileDir, incident, reason: culprit.patch.reason, message: `${culprit.patch.message}（未改任何文件）` };
  }
  let patch = null;
  if (culprit.patchText != null && culprit.patchBlocks.length) {
    patch = commentPatchEntries(culprit.patchText, name);
    if (!patch.ok) {
      return { ok: false, action: 'none', changed: false, home, profileDir, incident, reason: patch.reason, message: `${patch.message}（未改任何文件）` };
    }
  }
  const writesPkg = Boolean(culprit.depKey || culprit.bundleKeys.length);
  const backups = [];
  if (writesPkg) backups.push(backupPath(culprit.pkgFile, at));
  if (patch && patch.changed) backups.push(backupPath(culprit.patchFile, at));
  const entry = {
    name,
    reason: clip(`${incident.kind ?? 'crash'} · ${incident.signature ?? incident.message ?? ''}`, 160),
    at: new Date().toISOString(),
    incidentId: incident.id,
    artifact: incident.artifact ?? null,
    backups,
  };
  return {
    ok: true,
    action: 'quarantine',
    changed: false,
    home,
    profileDir,
    incident,
    culprit,
    patch,
    quarantineEntry: entry,
    plan: {
      name,
      home,
      profileDir,
      writesPkg,
      dependency: culprit.depKey ? { name: culprit.depKey, spec: culprit.depSpec } : null,
      bundles: culprit.bundleKeys,
      patch: patch && patch.changed ? { file: culprit.patchFile, entries: patch.commented } : null,
      backups,
      incident: { id: incident.id, ts: incident.ts, kind: incident.kind, signature: incident.signature, artifact: incident.artifact },
    },
  };
}

function describe(plan, dryRun) {
  const lines = [];
  const incident = plan.plan.incident;
  lines.push(`真凶：${plan.plan.name}（${incident.kind ?? 'crash'}，incident ${incident.id}）`);
  if (plan.plan.dependency) lines.push(`- 移除依赖：dependencies["${plan.plan.dependency.name}"]${plan.plan.dependency.spec ? ` = ${plan.plan.dependency.spec}` : ''}`);
  if (plan.plan.bundles.length) lines.push(`- 移出 dsh.profile.bundles：${plan.plan.bundles.join(', ')}`);
  if (plan.plan.patch) lines.push(`- 注释 cordis.patch.yml ${plan.plan.patch.entries.length} 个条目：${plan.plan.patch.entries.map((item) => item.id || item.name).join(', ')}`);
  if (plan.plan.backups.length) {
    const dir = path.dirname(plan.plan.backups[0]);
    const names = plan.plan.backups.map((file) => path.basename(file)).join('、');
    lines.push(`- 备份：${dir}/${names}`);
  }
  lines.push(`- 记入隔离清单：${path.join(plan.home, 'crash-lore', 'state.json')}`);
  if (dryRun) lines.push('未改动任何文件；加 --yes 才执行。');
  return lines;
}

function conclusion(plan) {
  const patchText = plan.plan.patch ? `，cordis.patch.yml 注释 ${plan.plan.patch.entries.length} 处` : '';
  const backupDir = plan.plan.backups.length ? path.dirname(plan.plan.backups[0]) : plan.profileDir;
  return `已隔离 ${plan.plan.name}：从依赖/bundles 移除${patchText}；备份在 ${backupDir}（*.bak-doctor-*）；重启 DSH 生效；撤销用 dsh-crash-lore doctor --restore ${plan.plan.name}`;
}

/**
 * 执行 doctor。
 * @param {object} [options] { home, profileDir, yes, dryRun }
 * @returns {object} 同步结果：{ ok, action:'none'|'plan'|'applied', changed, plan, lines, conclusion }
 */
/** A crash loop, not a one-off: same culprit seen several times inside a short window. */
export function autoEligible(home, name, options = {}) {
  const windowHours = options.windowHours ?? 24;
  const minHits = options.minHits ?? 3;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  let hits = 0;
  let recent = 0;
  for (const incident of readIncidents(home)) {
    if (String(incident?.culprit?.name ?? '') !== String(name ?? '')) continue;
    const when = Date.parse(incident?.lastTs || incident?.ts || '') || 0;
    const count = Math.max(1, Number(incident?.count) || 1);
    hits += count;
    if (when >= cutoff) recent += count;
  }
  const ok = recent >= minHits;
  return {
    ok,
    hits,
    recent,
    windowHours,
    minHits,
    message: ok
      ? `${name} 在 ${windowHours} 小时内崩了 ${recent} 次，达到自动隔离门槛（≥${minHits}）。`
      : `${name} 在 ${windowHours} 小时内崩了 ${recent} 次，未到自动隔离门槛（≥${minHits}）；只出计划，不写文件。`,
  };
}

export function runDoctor(options = {}) {
  let auto = null;
  if (options.auto === true && options.yes !== true) {
    const plannedForAuto = planDoctor(options);
    const name = plannedForAuto?.culprit?.name || plannedForAuto?.incident?.culprit?.name;
    auto = autoEligible(options.home || defaultHome(), name, options);
    if (!auto.ok) {
      return {
        ok: true,
        action: 'none',
        changed: false,
        reason: 'auto_threshold',
        auto,
        message: auto.message,
        plan: plannedForAuto?.plan || null,
        lines: [auto.message, '证据还不够，确认要隔离就加 --yes。'],
        conclusion: '未改动任何文件。',
      };
    }
    options = { ...options, yes: true };
  }
  const dryRun = options.dryRun === true || options.yes !== true;
  let planned;
  try {
    planned = planDoctor(options);
  } catch (error) {
    return { ok: false, action: 'none', changed: false, reason: 'exception', message: String(error?.message || error), lines: [] };
  }
  if (!planned.ok || planned.action === 'none') {
    return { ok: planned.ok, action: 'none', changed: false, reason: planned.reason, message: planned.message, plan: planned.plan || null, lines: planned.message ? [planned.message] : [] };
  }
  const lines = describe(planned, dryRun);
  if (dryRun) return { ok: true, action: 'plan', changed: false, dryRun: true, plan: planned.plan, lines, conclusion: '计划已就绪，未改动任何文件。' };

  const { plan } = planned;
  const at = stamp();
  const written = [];
  try {
    // 1) 备份（先备份，再动手）
    for (const backup of plan.backups) {
      const source = backup.includes(PATCH_FILE) ? planned.culprit.patchFile : planned.culprit.pkgFile;
      if (!fs.existsSync(backup)) fs.copyFileSync(source, backup);
      written.push(backup);
    }
    // 2) package.json：删依赖 + 移出 bundles（只有确实要改时才写，保证不动无关字节）
    if (plan.writesPkg) {
      const pkg = JSON.parse(fs.readFileSync(planned.culprit.pkgFile, 'utf8'));
      if (plan.dependency) delete pkg.dependencies[plan.dependency.name];
      if (plan.bundles.length && Array.isArray(pkg?.dsh?.profile?.bundles)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((item) => !refersTo(item, plan.name));
      }
      fs.writeFileSync(planned.culprit.pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    // 3) cordis.patch.yml：只注释真凶条目
    if (planned.patch && planned.patch.changed) fs.writeFileSync(planned.culprit.patchFile, planned.patch.text);
    // 4) 隔离记录
    const state = readState(planned.home);
    const quarantine = Array.isArray(state.quarantine) ? state.quarantine : [];
    quarantine.push(planned.quarantineEntry);
    writeState({ ...state, quarantine }, planned.home);
    const backupLine = plan.backups.length ? path.dirname(plan.backups[0]) : planned.profileDir;
    return {
      ok: true,
      action: 'applied',
      changed: true,
      dryRun: false,
      plan,
      lines,
      auto,
      conclusion: `已隔离 ${plan.name}：${plan.dependency ? '依赖已移除，' : ''}${plan.bundles.length ? 'bundles 已移除，' : ''}${plan.patch ? `patch 注释 ${plan.patch.entries.length} 处，` : ''}备份 ${backupLine}（*.bak-doctor-*）；重启 DSH 生效；撤销用 doctor --restore ${plan.name}`,
      written,
    };
  } catch (error) {
    return { ok: false, action: 'failed', changed: false, reason: 'write_failed', message: `写入失败：${error?.message || error}（已写入的备份：${written.join('、') || '无'}）`, plan, lines };
  }
}

/* --------------------------------------------------------------- restore */

function listBackups(profileDir, prefix) {
  try {
    return fs.readdirSync(profileDir).filter((name) => name.startsWith(prefix)).sort().reverse().map((name) => path.join(profileDir, name));
  } catch {
    return [];
  }
}

/**
 * 撤销隔离：从最新一份 doctor 备份里取回这条依赖（和 bundles 条目），
 * 并尽力把 patch 里被注释的条目恢复。
 * @returns {object} { ok, action:'restored'|'dry-run', changed, name, dependency, backup, patchRestored }
 */
export function restore(name, options = {}) {
  const target = String(name ?? '').trim();
  const home = path.resolve(options.home || defaultHome());
  const profileDir = path.resolve(options.profileDir || defaultProfileDir());
  if (!target) return { ok: false, action: 'none', changed: false, reason: 'missing_name', message: 'restore 需要包名' };
  const pkgFile = path.join(profileDir, PKG_FILE);
  const current = readJsonFile(pkgFile);
  if (!current || typeof current !== 'object') return { ok: false, action: 'none', changed: false, reason: 'profile_unreadable', message: `读不到 ${pkgFile}` };

  let source = null;
  for (const backup of listBackups(profileDir, `${PKG_FILE}.bak-doctor-`)) {
    const pkg = readJsonFile(backup);
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : null;
    if (!deps) continue;
    const key = Object.keys(deps).find((item) => item === target || refersTo(deps[item], target));
    if (key) {
      source = { backup, key, spec: deps[key], pkg };
      break;
    }
  }
  if (!source) {
    return { ok: false, action: 'none', changed: false, reason: 'no_backup', message: `没有找到 ${target} 的 doctor 备份（${profileDir}/${PKG_FILE}.bak-doctor-*）`, name: target };
  }

  const deps = current.dependencies && typeof current.dependencies === 'object' ? current.dependencies : {};
  const backupBundles = Array.isArray(source.pkg?.dsh?.profile?.bundles) ? source.pkg.dsh.profile.bundles : [];
  const bundleKeys = backupBundles.filter((item) => item === target || refersTo(item, target));
  const patchFile = path.join(profileDir, PATCH_FILE);
  const backupPatchFile = path.join(path.dirname(source.backup), path.basename(source.backup).replace(new RegExp(`^${PKG_FILE.replace('.', '\\.')}\\.bak-doctor-`), `${PATCH_FILE}.bak-doctor-`));
  let patchResult = { ok: true, changed: false, restored: 0 };
  if (fs.existsSync(patchFile) && fs.existsSync(backupPatchFile)) {
    patchResult = restorePatchEntries(readText(patchFile), readText(backupPatchFile), source.key);
  }
  const plan = {
    name: target,
    dependency: { name: source.key, spec: source.spec },
    bundles: bundleKeys,
    backup: source.backup,
    patchRestored: patchResult.ok ? patchResult.restored : 0,
    patchFile: patchResult.ok && patchResult.changed ? patchFile : null,
  };
  if (options.dryRun === true) {
    const lines = [`将从 ${source.backup} 恢复 ${source.key} = ${source.spec}`, `bundles：${bundleKeys.join(', ') || '无'}`, `patch 恢复 ${plan.patchRestored} 处`];
    return { ok: true, action: 'dry-run', changed: false, dryRun: true, name: target, plan, lines };
  }

  try {
    const backupDeps = source.pkg.dependencies && typeof source.pkg.dependencies === 'object' ? source.pkg.dependencies : {};
    const merged = {};
    for (const key of Object.keys(backupDeps)) {
      if (key === source.key) merged[key] = source.spec;
      else if (deps[key] !== undefined) merged[key] = deps[key];
    }
    for (const key of Object.keys(deps)) if (!(key in merged)) merged[key] = deps[key];
    current.dependencies = merged;
    const bundles = Array.isArray(current?.dsh?.profile?.bundles) ? current.dsh.profile.bundles : [];
    if (bundleKeys.length) {
      for (const item of bundleKeys) if (!bundles.includes(item)) bundles.push(item);
      current.dsh = current.dsh || {};
      current.dsh.profile = current.dsh.profile || {};
      current.dsh.profile.bundles = bundles;
    }
    fs.writeFileSync(pkgFile, `${JSON.stringify(current, null, 2)}\n`);
    if (patchResult.ok && patchResult.changed) fs.writeFileSync(patchFile, patchResult.text);
    const state = readState(home);
    const quarantine = Array.isArray(state.quarantine) ? state.quarantine : [];
    const removed = quarantine.filter((entry) => String(entry?.name ?? '') === target || String(entry?.name ?? '') === source.key);
    writeState({ ...state, quarantine: quarantine.filter((entry) => !removed.includes(entry)) }, home);
    return {
      ok: true,
      action: 'restored',
      changed: true,
      name: target,
      plan,
      conclusion: `已恢复 ${source.key}：依赖 ${source.key} = ${source.spec} 已写回${plan.patchRestored ? `，patch 恢复 ${plan.patchRestored} 处` : ''}；重启 DSH 生效。`,
      lines: [`- 依赖：dependencies["${source.key}"] = ${source.spec}`, ...(bundleKeys.length ? [`- bundles：${bundleKeys.join(', ')}`] : []), path.dirname(source.backup)],
    };
  } catch (error) {
    return { ok: false, action: 'failed', changed: false, reason: 'write_failed', message: `恢复失败：${error?.message || error}`, plan };
  }
}

/** cli.mjs `doctor --restore <name>` 的入口。 */
export function runRestore(name, options = {}) {
  return restore(name, options);
}
