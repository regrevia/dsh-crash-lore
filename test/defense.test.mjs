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
} from '../defense.mjs';

function tmp(prefix = 'crash-lore-defense-') {
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
  assert.match(reason, /^\[CRASH_LORE_BLOCKED\]/);
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

  assert.match(call(`rm -rf ${linked}`), /CRASH_LORE_BLOCKED/);
  assert.match(call(`rm -rf ${profile}`), /CRASH_LORE_BLOCKED/);
  assert.match(call(`mv ${linked} ${linked}-old`), /CRASH_LORE_BLOCKED/);
  /* deleting a parent takes the live tree with it */
  assert.match(call(`rm -rf ${root}`), /CRASH_LORE_BLOCKED/);
  /* relative target resolved against the command cwd */
  assert.match(call('rm -rf ../../dev-plugin', profile), /CRASH_LORE_BLOCKED/);

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
  assert.equal(decision.info.code, 'CRASH_LORE_BLOCKED');
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
