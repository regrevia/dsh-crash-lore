import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, restore, planDoctor, analyzePatch, commentPatchEntries, refersTo, autoEligible } from '../doctor.mjs';
import { appendIncident, readIncidents } from '../core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cl-doctor-home-'));
}

function sandbox({ profile = 'profile', home = 'home' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-doctor-'));
  /* 与真实布局一致：…/profiles/<名字>。隔离记录按 profile 名归属，目录名必须能对上事故里的 profile。 */
  const profileDir = path.join(dir, 'profiles', 'desktop');
  const homeDir = path.join(dir, 'home');
  fs.cpSync(path.join(FIXTURES, profile), profileDir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, home), homeDir, { recursive: true });
  return { dir, profileDir, homeDir };
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.readFileSync(full).toString('base64'));
    }
  };
  walk(root);
  return out;
}

function assertSameSnapshot(a, b, label) {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label}: 文件集合变了`);
  for (const [key, value] of a) assert.equal(b.get(key), value, `${label}: ${key} 内容变了`);
}

test('dryRun 默认生效：只出计划，一个字节都不写', () => {
  const box = sandbox();
  const before = snapshot(box.dir);
  const result = runDoctor({ home: box.homeDir, profileDir: box.profileDir });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'plan');
  assert.equal(result.changed, false);
  assert.ok(result.lines.some((line) => line.includes('dsh-bad')));
  assert.ok(result.lines.some((line) => line.includes('package.json.bak-doctor-')));
  assertSameSnapshot(before, snapshot(box.dir), 'dry run 不应写盘');
});

test('plan 选中最新、未被隔离、且确实在 profile 里的插件真凶', () => {
  const box = sandbox();
  const incidentsFile = path.join(box.homeDir, 'lifeguard', 'incidents.jsonl');
  const older = {
    id: 'inc_old_good',
    ts: '2025-10-01T00:00:00.000Z',
    kind: 'crash',
    signature: 'old crash',
    culprit: { type: 'plugin', name: 'dsh-good' },
    artifact: '/tmp/inc_old_good',
  };
  fs.appendFileSync(incidentsFile, `${JSON.stringify(older)}\n`);
  const planned = planDoctor({ home: box.homeDir, profileDir: box.profileDir });
  assert.equal(planned.action, 'quarantine');
  assert.equal(planned.plan.name, 'dsh-bad');
  assert.equal(planned.plan.dependency.name, 'dsh-bad');
  assert.deepEqual(planned.plan.bundles, ['dsh-bad']);
  assert.equal(planned.plan.patch.entries.length, 2);
});

test('--yes 真跑：移除依赖与 bundle、注释 patch 条目、留备份、记隔离', () => {
  const box = sandbox();
  const patchBefore = read(path.join(box.profileDir, 'cordis.patch.yml'));
  const result = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'applied');
  assert.equal(result.changed, true);
  assert.match(result.conclusion, /已隔离 dsh-bad/);

  const pkg = readJson(path.join(box.profileDir, 'package.json'));
  assert.equal(pkg.dependencies['dsh-bad'], undefined);
  assert.equal(pkg.dependencies['dsh-good'], 'link:/tmp/dsh-good');
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-good']);

  const patchAfter = read(path.join(box.profileDir, 'cordis.patch.yml'));
  const after = patchAfter.split('\n');
  const before = patchBefore.split('\n');
  const added = after.filter((line) => line.startsWith('# ')).length - before.filter((line) => line.startsWith('# ')).length;
  assert.equal(added, 8, `应该注释 2 个条目共 8 行，实际：\n${patchAfter}`);
  assert.ok(patchAfter.includes('# - id: bad-plugin'));
  assert.ok(patchAfter.includes('#     - id: bad-insert'));
  // 无关条目与注释头逐字节保留
  for (const untouched of ['# lifeguard fixture: 只有 dsh-bad 的条目该被注释，其余逐字节保留', '- id: good-plugin', '  name: "dsh-good"', '    - id: keep-insert', '- id: remote-web-ui']) {
    assert.ok(patchAfter.includes(untouched), `被误改：${untouched}`);
  }
  assert.equal(added, 8);

  const backups = fs.readdirSync(box.profileDir).filter((name) => name.includes('.bak-doctor-'));
  assert.equal(backups.length, 2, backups.join(','));
  assert.ok(backups.some((name) => name.startsWith('package.json.bak-doctor-')));
  assert.ok(backups.some((name) => name.startsWith('cordis.patch.yml.bak-doctor-')));

  const state = readJson(path.join(box.homeDir, 'lifeguard', 'state.json'));
  assert.deepEqual(state.scanned, { 'keep-me': 1 });
  assert.equal(state.quarantine.length, 1);
  const entry = state.quarantine[0];
  assert.equal(entry.name, 'dsh-bad');
  assert.equal(entry.incidentId, 'inc_bad_001');
  assert.equal(entry.artifact, '/tmp/inc_bad_001');
  assert.ok(entry.backups.length >= 2);
  for (const file of entry.backups) assert.equal(fs.existsSync(file), true, file);
});

test('重复 doctor：已隔离的真凶不再重复摘，且不产生新改动', () => {
  const box = sandbox();
  const first = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(first.action, 'applied');
  // 只留一条真凶 incident，去掉 core 的干扰
  const incidentsFile = path.join(box.homeDir, 'lifeguard', 'incidents.jsonl');
  const lines = read(incidentsFile).trim().split('\n').filter((line) => line.includes('inc_bad_001'));
  fs.writeFileSync(incidentsFile, `${lines.join('\n')}\n`);
  const before = snapshot(box.dir);
  const again = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(again.action, 'none');
  assert.match(String(again.reason), /no_candidate/);
  assertSameSnapshot(before, snapshot(box.dir), '第二次不应写盘');
});

test('restore：依赖、bundle、patch 全部回到原样，隔离记录清空', () => {
  const box = sandbox();
  const pkgBefore = read(path.join(box.profileDir, 'package.json'));
  const patchBefore = read(path.join(box.profileDir, 'cordis.patch.yml'));
  runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  const result = restore('dsh-bad', { home: box.homeDir, profileDir: box.profileDir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'restored');
  assert.equal(read(path.join(box.profileDir, 'package.json')), pkgBefore);
  assert.equal(read(path.join(box.profileDir, 'cordis.patch.yml')), patchBefore);
  const state = readJson(path.join(box.homeDir, 'lifeguard', 'state.json'));
  assert.equal(state.quarantine.length, 0);
  assert.deepEqual(state.scanned, { 'keep-me': 1 });
});

test('restore：没有备份时干净失败，不改任何东西', () => {
  const box = sandbox();
  const before = snapshot(box.dir);
  const result = restore('dsh-bad', { home: box.homeDir, profileDir: box.profileDir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_backup');
  assertSameSnapshot(before, snapshot(box.dir), '失败路径不应写盘');
});

test('cordis.patch.yml 结构看不懂时整体放弃，不半写', () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.profileDir, 'cordis.patch.yml'), '- id: bad-plugin\n\tname: "dsh-bad"\n');
  fs.cpSync(path.join(FIXTURES, 'profile-patchonly', 'package.json'), path.join(box.profileDir, 'package.json'));
  const before = snapshot(box.dir);
  const result = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(String(result.reason), /tab_indent/);
  assertSameSnapshot(before, snapshot(box.dir), '放弃路径不应写盘');
});

test('真凶只在 patch 里时：只注释 patch，package.json 不重写', () => {
  const box = sandbox({ profile: 'profile-patchonly' });
  const pkgBefore = read(path.join(box.profileDir, 'package.json'));
  const result = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, 'applied');
  assert.equal(read(path.join(box.profileDir, 'package.json')), pkgBefore);
  assert.equal(result.plan.bundles.length, 0);
  assert.equal(result.plan.dependency, null);
  assert.ok(read(path.join(box.profileDir, 'cordis.patch.yml')).includes('# - id: bad-plugin'));
  const backups = fs.readdirSync(box.profileDir).filter((name) => name.includes('.bak-doctor-'));
  assert.equal(backups.length, 1);
  assert.ok(backups[0].startsWith('cordis.patch.yml.bak-doctor-'));
  assert.equal(readJson(path.join(box.homeDir, 'lifeguard', 'state.json')).quarantine.length, 1);
});

test('没有插件类真凶时返回 none；profile 读不到时干净失败', () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.homeDir, 'lifeguard', 'incidents.jsonl'), `${JSON.stringify({
    id: 'inc_core_only',
    ts: '2025-10-21T00:00:00.000Z',
    kind: 'crash',
    signature: 'oom',
    culprit: { type: 'core', name: 'core' },
    artifact: '/tmp/inc_core_only',
  })}\n`);
  const none = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(none.action, 'none');
  assert.match(String(none.reason), /no_candidate/);

  const broken = sandbox();
  fs.rmSync(path.join(broken.profileDir, 'package.json'));
  const failed = runDoctor({ home: broken.homeDir, profileDir: broken.profileDir, yes: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'profile_unreadable');
});

test('refersTo 能认出 link:/file: 路径与文件路径', () => {
  assert.equal(refersTo('dsh-bad', 'dsh-bad'), true);
  assert.equal(refersTo('link:/tmp/dsh-bad', 'dsh-bad'), true);
  assert.equal(refersTo('file:/tmp/dsh-bad/index.js', 'dsh-bad'), true);
  assert.equal(refersTo('file:///tmp/dsh-bad/index.js', 'dsh-bad'), true);
  assert.equal(refersTo('file:///tmp/dsh-other/index.js', 'dsh-bad'), false);
  assert.equal(refersTo('@scope/dsh-bad', '@scope/dsh-bad'), true);
  assert.equal(refersTo('dsh-good', 'dsh-bad'), false);
});

test('analyzePatch 只扫条目，注释后其余结构完好', () => {
  const text = read(path.join(FIXTURES, 'profile', 'cordis.patch.yml'));
  const analysis = analyzePatch(text);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.blocks.filter((block) => block.parent === null).length, 4);
  const result = commentPatchEntries(text, 'dsh-bad');
  assert.equal(result.ok, true);
  assert.equal(result.commented.length, 2);
  const after = analyzePatch(result.text);
  assert.equal(after.ok, true);
  assert.equal(after.blocks.filter((block) => block.id === 'bad-plugin').length, 0);
  assert.equal(after.blocks.filter((block) => block.id === 'keep-insert').length, 1);
});

test('autoEligible only fires on a crash loop', () => {
  const home = tmpHome();
  const now = new Date().toISOString();
  /* Real per-event identity: three timestamped occurrences inside the window. */
  appendIncident({ id: 'inc_a', kind: 'uncaught-exception', ts: now, lastTs: now, count: 3, occurrenceIds: ['o1', 'o2', 'o3'], occurrenceTimes: [now, now, now], culprit: { name: 'p-loop' }, fingerprint: 'f1' }, home);
  appendIncident({ id: 'inc_b', kind: 'uncaught-exception', ts: now, lastTs: now, count: 1, occurrenceIds: ['o4'], occurrenceTimes: [now], culprit: { name: 'p-once' }, fingerprint: 'f2' }, home);
  assert.equal(autoEligible(home, 'p-loop').ok, true);
  assert.equal(autoEligible(home, 'p-once').ok, false);
  assert.equal(autoEligible(home, 'p-once', { minHits: 1 }).ok, true);
  assert.equal(autoEligible(home, 'p-unknown').ok, false);
});

test('autoEligible：没有逐次时间的旧累计条目，不能凭 count 伪造 24h 崩溃循环', () => {
  const home = tmpHome();
  const now = new Date().toISOString();
  /* Legacy aggregate: count 100, last crash today, but nothing proves the other 99 were recent. */
  appendIncident({ id: 'inc_legacy', kind: 'uncaught-exception', ts: '2025-01-01T00:00:00.000Z', lastTs: now, count: 100, culprit: { name: 'p-legacy' }, fingerprint: 'fl' }, home);
  const verdict = autoEligible(home, 'p-legacy');
  assert.equal(verdict.recent, 1, '窗口内只算最后一次已知事件，不能把累计次数当窗口内次数');
  assert.equal(verdict.ok, false, '累计 100 次不等于 24h 内崩了 100 次');
  assert.equal(verdict.hits, 100, '生命周期总数仍保留，只是不用于窗口判定');
});

test('restore：只注释过 patch 的隔离也能撤销（patch-only，不要求 package.json 备份）', () => {
  const box = sandbox({ profile: 'profile-patchonly' });
  const original = read(path.join(box.profileDir, 'cordis.patch.yml'));
  const applied = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(applied.action, 'applied', JSON.stringify(applied));
  assert.ok(read(path.join(box.profileDir, 'cordis.patch.yml')).includes('# - id: bad-plugin'));

  const restored = restore('dsh-bad', { home: box.homeDir, profileDir: box.profileDir });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.patchOnly, true);
  assert.equal(restored.patchRestored, 2, 'bad-plugin 与 insert 里的 bad-insert 两处都该恢复');
  assert.equal(read(path.join(box.profileDir, 'cordis.patch.yml')), original, 'patch 应逐字节恢复成隔离前');
  assert.equal(readJson(path.join(box.homeDir, 'lifeguard', 'state.json')).quarantine.length, 0);
});

test('写入中途失败：已改的文件回滚，profile 不留半套状态', () => {
  const box = sandbox();
  const pkgBefore = read(path.join(box.profileDir, 'package.json'));
  const patchBefore = read(path.join(box.profileDir, 'cordis.patch.yml'));
  fs.chmodSync(path.join(box.profileDir, 'cordis.patch.yml'), 0o444);

  const result = runDoctor({ home: box.homeDir, profileDir: box.profileDir, yes: true });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, 'write_failed');
  assert.equal(result.changed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(read(path.join(box.profileDir, 'package.json')), pkgBefore, 'package.json 必须回到原样');
  assert.equal(read(path.join(box.profileDir, 'cordis.patch.yml')), patchBefore);
  assert.equal((readJson(path.join(box.homeDir, 'lifeguard', 'state.json')).quarantine || []).length, 0, '失败时不写隔离记录');
});

test('隔离记录按 profile 归属：别的 profile 隔离过同一个插件，不影响这里摘它', () => {
  const box = sandbox();
  /* 同样的真凶，在 work profile 被隔离过；desktop 的 state 不该因此跳过。 */
  const stateFile = path.join(box.homeDir, 'lifeguard', 'state.json');
  const state = readJson(stateFile);
  writeJson(stateFile, { ...state, quarantine: [{ name: 'dsh-bad', profile: 'work', at: new Date().toISOString() }] });
  const planned = runDoctor({ home: box.homeDir, profileDir: box.profileDir });
  assert.equal(planned.action, 'plan', JSON.stringify(planned));

  /* 本 profile 自己的记录仍然生效：已隔离就不重复摘。 */
  writeJson(stateFile, { ...state, quarantine: [{ name: 'dsh-bad', profile: 'desktop', at: new Date().toISOString() }] });
  const again = runDoctor({ home: box.homeDir, profileDir: box.profileDir });
  assert.equal(again.action, 'none', JSON.stringify(again));
  assert.equal(again.reason, 'no_candidate');
});

test('autoEligible：24 小时窗口按真实事件时间算，历史 100 次 + 今天 1 次不算崩溃循环', () => {
  const home = tmpHome();
  const old = Array.from({ length: 100 }, (_, at) => new Date(Date.UTC(2025, 9, 1, 0, 0, at)).toISOString());
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  appendIncident({ id: 'inc_loop_old', ts: old[0], lastTs: recent, count: 101, occurrenceTimes: [...old, recent], fingerprint: 'old', kind: 'crash', signature: 'boom', culprit: { type: 'plugin', name: 'dsh-bad' } }, home);
  const notLoop = autoEligible(home, 'dsh-bad');
  assert.equal(notLoop.ok, false);
  assert.equal(notLoop.recent, 1, '窗口内只有今天那一次');
  assert.equal(notLoop.hits, 101);

  const home2 = tmpHome();
  const three = [0, 1, 2].map((at) => new Date(Date.now() - (at + 1) * 60 * 1000).toISOString());
  appendIncident({ id: 'inc_loop_new', ts: three[0], lastTs: three[2], count: 3, occurrenceTimes: three, fingerprint: 'new', kind: 'crash', signature: 'boom', culprit: { type: 'plugin', name: 'dsh-bad' } }, home2);
  assert.equal(autoEligible(home2, 'dsh-bad').ok, true, '窗口内真崩了 3 次才算循环');
});

test('analyzePatch：CRLF 的 patch 一样能扫出条目', () => {
  const text = ['patch:', '  - id: keep', '    disabled: false', ''].join('\r\n');
  const result = analyzePatch(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocks.map((block) => block.id), ['keep']);
});
