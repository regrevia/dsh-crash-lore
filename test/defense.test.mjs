import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectText,
  classify,
  liveSurfaces,
  guardWrite,
  guardShell,
  preExecute,
  candidateDir,
  blockReason,
  markSurfacesDirty,
  refreshSurfaces,
  lastPreflightStatus,
} from '../defense.mjs';

function tmp(prefix = 'lifeguard-defense-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A profile whose dependencies point at a linked plugin dir plus an installed one. */
function fixtureProfile() {
  const root = tmp();
  const profile = path.join(root, 'profiles', 'desktop');
  const linked = path.join(root, 'dev-plugin');
  write(path.join(linked, 'package.json'), JSON.stringify({ name: 'dev-plugin', version: '1.0.0', type: 'module' }));
  write(path.join(linked, 'index.js'), 'export function apply() {}\n');
  const installed = path.join(profile, 'node_modules', 'installed-plugin');
  write(path.join(installed, 'package.json'), JSON.stringify({ name: 'installed-plugin', version: '1.0.0', type: 'module' }));
  write(path.join(installed, 'index.js'), 'export function apply() {}\n');
  write(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: {
      'dev-plugin': `link:${linked}`,
      'installed-plugin': '^1.0.0',
    },
  }));
  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: a\n      name: dev-plugin\n');
  return { root, profile, linked, installed };
}

test('inspectText refuses only shapes that crash activation', () => {
  const throwTop = inspectText("import x from 'y';\nthrow new Error('boom');\n", '/p/index.js');
  assert.equal(throwTop.ruleId, 'P014');
  assert.equal(throwTop.line, 2);

  assert.equal(inspectText('export function apply() {\n  throw new Error("inside");\n}\n', '/p/index.js'), null);

  const exit = inspectText('export function apply() { process.exit(1); }\n', '/p/index.js');
  assert.equal(exit.ruleId, 'P018');

  const signal = inspectText("process.on('SIGTERM', () => {});\n", '/p/index.mjs');
  assert.equal(signal.ruleId, 'P019');

  const req = inspectText("const fs = require('node:fs');\n", '/p/index.mjs');
  assert.equal(req.ruleId, 'P016');

  assert.equal(inspectText("import fs from 'node:fs';\n", '/p/index.mjs'), null);

  const dup = inspectText('- insert:\n    - id: a\n    - id: a\n', '/profile/cordis.patch.yml');
  assert.equal(dup.ruleId, 'P009');

  const badJson = inspectText('{ "name": "x", }', '/profile/package.json');
  assert.equal(badJson.ruleId, 'P001');

  const secret = inspectText('providers:\n  apiKey: "sk-abcdefgh12345678"\n', '/profile/cordis.patch.yml');
  assert.equal(secret.ruleId, 'secret');

  /* dev-only scripts are not live activation paths */
  assert.equal(inspectText('process.exit(0);\n', '/p/scripts/build.mjs'), null);
});

test('classify separates live surfaces from ordinary files', () => {
  const { profile, linked, installed, root } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  assert.equal(classify(path.join(linked, 'index.js'), surfaces).kind, 'plugin-source');
  assert.equal(classify(path.join(linked, 'index.js'), surfaces).linked, true);
  assert.equal(classify(path.join(installed, 'index.js'), surfaces).kind, 'plugin-source');
  assert.equal(classify(path.join(profile, 'cordis.patch.yml'), surfaces).kind, 'profile-patch');
  assert.equal(classify(path.join(profile, 'package.json'), surfaces).kind, 'profile-manifest');
  assert.equal(classify(path.join(root, 'notes.md'), surfaces).live, false);
  assert.equal(classify('/tmp/unrelated/index.js', surfaces).live, false);
});

test('a write that introduces a top-level throw into a live plugin is refused', () => {
  const { profile, linked, root } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const seen = [];
  const reason = guardWrite(
    { name: 'write', arguments: { file_path: path.join(linked, 'index.js'), content: "throw new Error('boom at import');\n" } },
    { surfaces, onDeny: (finding, surface, file, text) => seen.push({ finding, surface, file, text }) },
  );
  assert.match(reason, /^\[LIFEGUARD_BLOCKED\]/);
  assert.match(reason, /P014/);
  assert.match(reason, /本次操作未执行/);
  assert.match(reason, /建议：/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].surface.name, 'dev-plugin');

  /* the same text outside the live profile is the developer's business */
  assert.equal(guardWrite(
    { name: 'write', arguments: { file_path: path.join(root, 'scratch.js'), content: "throw new Error('x');\n" } },
    { surfaces },
  ), undefined);

  /* a normal live edit passes */
  assert.equal(guardWrite(
    { name: 'write', arguments: { file_path: path.join(linked, 'index.js'), content: 'export function apply() { return 1; }\n' } },
    { surfaces },
  ), undefined);
});

test('edit is judged by the text it would leave behind', () => {
  const { profile, linked } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const file = path.join(linked, 'index.js');
  write(file, 'export function apply() {}\n// tail\n');

  const reason = guardWrite(
    { name: 'edit', arguments: { file_path: file, old_string: 'export function apply() {}', new_string: "throw new Error('broken');" } },
    { surfaces },
  );
  assert.match(reason, /P014/);

  assert.equal(guardWrite(
    { name: 'edit', arguments: { file_path: file, old_string: '// tail', new_string: 'export const tail = 1;' } },
    { surfaces },
  ), undefined);

  /* an edit that cannot be resolved is left to the tool itself */
  assert.equal(guardWrite(
    { name: 'edit', arguments: { file_path: file, old_string: 'no such text', new_string: 'x' } },
    { surfaces },
  ), undefined);
});

test('only deleting/moving a live root is refused; single files inside it are fine', () => {
  const { profile, linked, root } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const call = (command, cwd = root) => guardShell({ name: 'bash', arguments: { command, cwd } }, { surfaces });

  /* the exact command that was over-blocked in practice: removing one scratch file */
  assert.equal(call(`rm -f ${linked}/scratch-guard-test.js && git status`), undefined);
  assert.equal(call(`rm ${linked}/index.js.bak`), undefined);
  assert.equal(call(`rm -rf ${linked}/dist`), undefined);

  assert.match(call(`rm -rf ${linked}`), /LIFEGUARD_BLOCKED/);
  assert.match(call(`rm -rf ${profile}`), /LIFEGUARD_BLOCKED/);
  assert.match(call(`mv ${linked} ${linked}-old`), /LIFEGUARD_BLOCKED/);
  /* deleting a parent takes the live tree with it */
  assert.match(call(`rm -rf ${root}`), /LIFEGUARD_BLOCKED/);
  /* relative target resolved against the command cwd */
  assert.match(call('rm -rf ../../dev-plugin', profile), /LIFEGUARD_BLOCKED/);

  assert.equal(call('rm -rf /tmp/nothing-here'), undefined);
  assert.equal(call(`cat ${linked}/index.js`), undefined);
});

test('install/enable of a candidate with a known crash shape is denied before it runs', async () => {
  const { profile, root } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const bad = path.join(root, 'bad-plugin');
  write(path.join(bad, 'package.json'), JSON.stringify({ name: 'bad-plugin', version: '1.0.0', type: 'module' }));
  write(path.join(bad, 'index.js'), "throw new Error('boom at import');\n");

  const decision = await preExecute(
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: bad } },
    { surfaces, profileDir: profile },
  );
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'LIFEGUARD_BLOCKED');
  assert.equal(decision.info.rule, 'P014');
  assert.match(decision.reason, /安装/);

  const good = path.join(root, 'good-plugin');
  write(path.join(good, 'package.json'), JSON.stringify({ name: 'good-plugin', version: '1.0.0', type: 'module' }));
  write(path.join(good, 'index.js'), 'export function apply() {}\n');
  assert.equal(await preExecute(
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: good } },
    { surfaces, profileDir: profile },
  ), undefined);

  /* disabling is never blocked */
  assert.equal(await preExecute(
    { name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'bad-plugin', enabled: false } },
    { surfaces, profileDir: profile },
  ), undefined);
});

test('candidateDir maps what the loader calls the plugin to its source dir', () => {
  const { profile, linked, installed } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  assert.equal(candidateDir({ target: 'include:dev-plugin' }, surfaces), linked);
  assert.equal(candidateDir({ target: 'dev-plugin' }, surfaces), linked);
  assert.equal(candidateDir({ target: 'installed-plugin' }, surfaces), installed);
  assert.equal(candidateDir({ target: 'never-installed' }, surfaces), null);
});

test('refusal text carries state, target, rule, risk and a way forward', () => {
  const reason = blockReason({
    surface: { name: 'dev-plugin' },
    finding: { ruleId: 'P014', title: '模块顶层有 throw', line: 3, message: 'm', fix: '挪进 apply()', snippet: "throw new Error('x')" },
    file: '/p/index.js',
    action: '写入',
  });
  for (const part of ['本次操作未执行', 'dev-plugin', '/p/index.js:3', 'P014', '风险：', '建议：', '继续读代码', '写入']) {
    assert.ok(reason.includes(part), `missing ${part}`);
  }
});

test('a relative write is resolved against the originating session directory', () => {
  const { profile, linked } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const call = (file, cwd) => guardWrite(
    { name: 'write', arguments: { file_path: file, content: "throw new Error('boom');\n" } },
    { surfaces, cwd },
  );

  /* the file is live when the session sits in the parent of the linked plugin */
  const reason = call(path.basename(linked) + '/index.js', path.dirname(linked));
  assert.match(reason, /P014/);

  /* no session directory at all: refuse with an explicit reason, never guess */
  const blind = call(path.basename(linked) + '/index.js', undefined);
  assert.match(blind, /unresolved/);
  assert.match(blind, /相对路径/);
  assert.match(blind, /绝对路径/);

  /* the same relative path resolving outside every live root is ordinary work */
  assert.equal(call('scratch.js', path.dirname(linked)), undefined);
});

test('a symlink pointing at a live plugin is the live plugin', () => {
  const { profile, linked, root } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const link = path.join(root, 'link-live');
  fs.symlinkSync(linked, link);
  const reason = guardWrite(
    { name: 'write', arguments: { file_path: path.join(link, 'index.js'), content: "throw new Error('boom');\n" } },
    { surfaces },
  );
  assert.match(reason, /P014/);
  assert.match(reason, /dev-plugin/);
});

test('a live plugin under an ancestor named tools/bin/test is still judged', () => {
  const { profile, root } = fixtureProfile();
  for (const dir of ['tools', 'bin', 'test']) {
    const plugin = path.join(root, dir, 'nested-plugin');
    write(path.join(plugin, 'package.json'), JSON.stringify({ name: 'nested-plugin', type: 'module' }));
    const file = path.join(plugin, 'index.js');
    write(file, 'export const a = 1;\n');
    const pkgFile = path.join(profile, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies['nested-plugin'] = `link:${plugin}`;
    write(pkgFile, JSON.stringify(pkg));
    const surfaces = liveSurfaces(profile);
    const reason = guardWrite(
      { name: 'write', arguments: { file_path: file, content: "throw new Error('boom');\n" } },
      { surfaces },
    );
    assert.match(reason, /P014/, `ancestor ${dir} must not skip inspection`);
    delete pkg.dependencies['nested-plugin'];
    write(pkgFile, JSON.stringify(pkg));
  }
});

test('the surface snapshot is refreshed in place after the profile changes', () => {
  const { profile, root, linked } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  assert.equal(classify(path.join(linked, 'index.js'), surfaces).live, true);

  const before = surfaces.refreshedAt;
  assert.ok(surfaces.refreshedAt >= before);
  assert.equal(surfaces.stale, false);

  /* mutate the snapshot the way activation would: in place, no new object */
  const additions = path.join(root, 'late-plugin');
  write(path.join(additions, 'package.json'), JSON.stringify({ name: 'late-plugin', type: 'module' }));
  write(path.join(additions, 'index.js'), 'export const a = 1;\n');
  const pkgFile = path.join(profile, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies['late-plugin'] = `link:${additions}`;
  write(pkgFile, JSON.stringify(pkg));
  markSurfacesDirty(surfaces);
  refreshSurfaces(surfaces, profile);
  assert.equal(surfaces.plugins.some((entry) => entry.name === 'late-plugin'), true);
  assert.equal(classify(path.join(additions, 'index.js'), surfaces).live, true);

  /* a refresh that cannot stat keeps the old values and never throws */
  const saved = surfaces.profileDir;
  surfaces.profileDir = path.join(root, 'gone');
  surfaces.pkgFile = path.join(root, 'gone', 'package.json');
  markSurfacesDirty(surfaces);
  refreshSurfaces(surfaces, surfaces.profileDir);
  assert.equal(typeof surfaces.stale, 'boolean');
  surfaces.profileDir = saved;
});

test('enable mapping reaches the entry id the loader actually uses', async () => {
  const { profile } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const dir = candidateDir({ action: 'set_plugin', target: 'include:dev-plugin' }, surfaces);
  assert.equal(fs.realpathSync(dir), fs.realpathSync(path.join(surfaces.profileDir, '..', '..', 'dev-plugin')));

  const finding = await preExecute(
    { name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'include:dev-plugin', enabled: true } },
    { surfaces, profileDir: profile },
  );
  assert.equal(finding, undefined);

  const bad = path.join(dir, 'index.js');
  write(bad, "throw new Error('boom');\n");
  const decision = await preExecute(
    { name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'include:dev-plugin', enabled: true } },
    { surfaces, profileDir: profile },
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.info.rule, /P014/);
});

test('set_bundle refuses with 未检查 when the enabled content cannot be opened', async () => {
  const { profile } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const decision = await preExecute(
    { name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'ghost-bundle', enabled: true } },
    { surfaces, profileDir: profile },
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /未检查/);
  assert.match(decision.reason, /install_bundle/);

  /* disabling a bundle is never gated */
  assert.equal(await preExecute(
    { name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'ghost-bundle', enabled: false } },
    { surfaces, profileDir: profile },
  ), undefined);
});

test('the same relative path is judged per originating session directory', () => {
  const { profile, root, linked } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const other = tmp('lifeguard-other-session-');
  const agentIn = { session: { header: { cwd: path.dirname(linked) } } };
  const agentOut = { session: { header: { cwd: other } } };
  const call = (agent) => guardWrite(
    { name: 'write', arguments: { file_path: path.basename(linked) + '/index.js', content: "throw new Error('boom');\n" }, agent },
    { surfaces },
  );

  /* session A sits above the live plugin: the relative path lands on a live file */
  assert.match(call(agentIn), /P014/);
  /* session B sits elsewhere: the same relative path is ordinary work for it */
  assert.equal(call(agentOut), undefined);
  /* and the other session's check did not poison A's judgement */
  assert.match(call(agentIn), /P014/);
  fs.rmSync(other, { recursive: true, force: true });
});

test('disabling a live entry removes it from the protection scope after refresh', () => {
  const { profile, linked } = fixtureProfile();
  const surfaces = liveSurfaces(profile);
  const file = path.join(linked, 'index.js');
  const bad = "throw new Error('boom');\n";
  assert.match(guardWrite({ name: 'write', arguments: { file_path: file, content: bad } }, { surfaces }), /P014/);

  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: a\n      name: dev-plugin\n      disabled: true\n');
  markSurfacesDirty(surfaces);
  refreshSurfaces(surfaces, profile);
  assert.equal(classify(file, surfaces).live, false);
  assert.equal(guardWrite({ name: 'write', arguments: { file_path: file, content: bad } }, { surfaces }), undefined);

  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: a\n      name: dev-plugin\n');
  markSurfacesDirty(surfaces);
  refreshSurfaces(surfaces, profile);
  assert.equal(classify(file, surfaces).live, true);
});

/** A plugin whose own bundle patch is the only thing it contributes (cold-install shape). */
function coldInstallFixture() {
  const root = tmp('lifeguard-cold-');
  const profile = path.join(root, 'profile');
  const plugin = path.join(root, 'own-bundled');
  write(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'own-bundled',
    version: '1.0.0',
    type: 'module',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }));
  write(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: own-a\n      name: own-bundled\n');
  write(path.join(plugin, 'index.js'), 'export function apply() {}\n');
  /* no dsh.profile.bundles: a cold/install-time profile has not mounted any bundle yet */
  write(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'own-bundled': `link:${plugin}` } }));
  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: own\n      name: own-bundled\n');
  return { root, profile, plugin };
}

test('a self-bundling plugin is live even when the profile declares no bundles', () => {
  const { profile, plugin } = coldInstallFixture();
  const surfaces = liveSurfaces(profile);
  const file = path.join(plugin, 'index.js');
  assert.equal(classify(file, surfaces).live, true);
  const reason = guardWrite({ name: 'write', arguments: { file_path: file, content: "throw new Error('boom');\n" } }, { surfaces });
  assert.match(reason, /P014/);

  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: own\n      name: own-bundled\n      disabled: true\n');
  markSurfacesDirty(surfaces);
  refreshSurfaces(surfaces, profile);
  assert.equal(classify(file, surfaces).live, false);
  assert.equal(guardWrite({ name: 'write', arguments: { file_path: file, content: "throw new Error('boom');\n" } }, { surfaces }), undefined);
});

/** Twenty entry files of a size that makes the install budget observable. */
function installCandidate({ broken = false, bytes = 400 * 1024 } = {}) {
  const dir = tmp('lifeguard-candidate-');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'candidate', version: '1.0.0', type: 'module' }));
  for (let i = 0; i < 20; i += 1) {
    const lines = [];
    for (let n = 0; n < Math.ceil(bytes / 40); n += 1) lines.push(`export const v${i}_${n} = ${n};`);
    const text = i === 19 && broken ? 'export function apply( {\n' : `${lines.join('\n')}\n`;
    write(path.join(dir, `feature-${String(i).padStart(2, '0')}`, 'index.js'), text);
  }
  return dir;
}

const installExec = (target) => ({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: `link:${target}` } });

test('install refuses a candidate whose entry syntax is broken, and allows the same shape when legal', async () => {
  const { profile } = coldInstallFixture();
  const surfaces = liveSurfaces(profile);

  const good = installCandidate();
  const allowed = await preExecute(installExec(good), { surfaces });
  assert.equal(allowed, undefined, 'twenty large but legal entries must not be refused');

  const bad = installCandidate({ broken: true });
  const refused = await preExecute(installExec(bad), { surfaces });
  assert.equal(refused?.kind, 'deny');
  assert.equal(refused.info.rule, 'P013');
  assert.match(refused.reason, /P013/);
  const status = lastPreflightStatus();
  assert.equal(status.unchecked, 0);
  assert.ok(status.checked > 0);
});

test('install refuses with uninspected when the budget cannot finish, and never calls it a syntax error', async () => {
  const { profile } = coldInstallFixture();
  const surfaces = liveSurfaces(profile);
  const dir = installCandidate();
  const refused = await preExecute(installExec(dir), { surfaces, installBudgetMs: 5 });
  assert.equal(refused?.kind, 'deny');
  assert.equal(refused.info.rule, 'uninspected');
  assert.match(refused.reason, /未完成|未检查/);
  assert.doesNotMatch(refused.reason, /语法不合法/);
  assert.equal(lastPreflightStatus().unchecked, 20);
});
