import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guardWrite,
  guardShell,
  liveSurfaces,
} from '../defense.mjs';
import { mergeJudge } from '../lib/judge.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A profile with one linked plugin that is live, so every rule is judged in the runtime's own terms. */
function liveProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-lore-rules-'));
  const profile = path.join(root, 'profiles', 'desktop');
  const plugin = path.join(root, 'plugin');
  write(path.join(plugin, 'package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0', type: 'module' }));
  write(path.join(plugin, 'index.js'), 'export function apply() {}\n');
  write(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { plugin: `link:${plugin}` },
  }));
  write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: p\n      name: plugin\n');
  return { root, profile, plugin, surfaces: liveSurfaces(profile) };
}

function liveWrite(env, rel, text) {
  const file = path.join(env.plugin, rel);
  return guardWrite({ name: 'write', arguments: { file_path: file, content: text } }, { surfaces: env.surfaces });
}

function profileWrite(env, rel, text) {
  const file = path.join(env.profile, rel);
  return guardWrite({ name: 'write', arguments: { file_path: file, content: text } }, { surfaces: env.surfaces });
}

/** One hard-block rule: a dangerous sample must be denied with that rule, its legal twin must pass. */
const MATRIX = [
  {
    rule: 'P014',
    name: '模块顶层 throw',
    dangerous: "throw new Error('at import');\n",
    legal: "export function apply() {\n  try { throw new Error('handled'); } catch {}\n}\n",
  },
  {
    rule: 'P015',
    name: '模块顶层裸 await',
    dangerous: "await Promise.resolve(1);\nexport const a = 1;\n",
    legal: "export async function apply() {\n  await Promise.resolve(1);\n}\n",
  },
  {
    rule: 'P016',
    name: 'ESM 里用 require',
    dangerous: "const fs = require('node:fs');\n",
    legal: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nvoid require;\n",
  },
  {
    rule: 'P018',
    name: '接管进程退出',
    dangerous: 'export function apply() { process.exit(1); }\n',
    legal: "// process.exit(1) is forbidden here\nexport const note = 'never call process.exit(1)';\n",
  },
  {
    rule: 'P019',
    name: '接管宿主信号',
    dangerous: "process.on('SIGTERM', () => {});\n",
    legal: "// process.on('SIGTERM', () => {}) stays out\nprocess.on('message', () => {});\n",
  },
];

for (const sample of MATRIX) {
  test(`${sample.rule} ${sample.name}: dangerous source is denied, its legal twin runs`, () => {
    const env = liveProfile();
    const reason = liveWrite(env, 'index.mjs', sample.dangerous);
    assert.ok(reason, `${sample.rule} legal twin expected a refusal`);
    assert.match(reason, new RegExp(sample.rule));
    assert.match(reason, /本次操作未执行/);
    assert.equal(liveWrite(env, 'index.mjs', sample.legal), undefined, `${sample.rule} legal twin must be allowed`);
  });
}

test('P009 duplicate patch id: one id twice is denied, distinct ids pass', () => {
  const env = liveProfile();
  const dup = profileWrite(env, 'cordis.patch.yml', '- insert:\n    - id: a\n      name: plugin\n    - id: a\n      name: plugin\n');
  assert.match(dup, /P009/);
  assert.equal(profileWrite(env, 'cordis.patch.yml', '- insert:\n    - id: a\n      name: plugin\n    - id: b\n      name: plugin\n'), undefined);
});

test('P001 broken profile JSON is denied, valid JSON passes', () => {
  const env = liveProfile();
  assert.match(profileWrite(env, 'package.json', '{ "name": "profile", }'), /P001/);
  assert.equal(profileWrite(env, 'package.json', JSON.stringify({ name: 'profile', dependencies: { plugin: `link:${env.plugin}` } })), undefined);
});

test('plaintext credentials in a live config are denied, apiKeyEnv passes', () => {
  const env = liveProfile();
  const secret = profileWrite(env, 'cordis.patch.yml', 'providers:\n  apiKey: "sk-abcdefgh12345678"\n');
  assert.match(secret, /secret/);
  assert.equal(profileWrite(env, 'cordis.patch.yml', 'providers:\n  apiKeyEnv: DEEPSEEK_API_KEY\n'), undefined);
});

test('deleting a live root is denied, deleting one file inside it is ordinary work', () => {
  const env = liveProfile();
  const call = (command) => guardShell({ name: 'bash', arguments: { command, cwd: env.root } }, { surfaces: env.surfaces });
  assert.match(call(`rm -rf ${env.plugin}`), /live-delete/);
  assert.match(call(`mv ${env.plugin} ${env.plugin}-old`), /live-delete/);
  assert.equal(call('rm -f plugin/scratch.js'), undefined);
  assert.equal(call('mv plugin/scratch.js plugin/scratch.bak'), undefined);
});

test('CLI and runtime judge the same files the same way', () => {
  const env = liveProfile();
  const sources = [
    ["throw new Error('at import');\n", 'P014'],
    ["const fs = require('node:fs');\n", 'P016'],
    ['export function apply() { process.exit(1); }\n', 'P018'],
    ["process.on('SIGTERM', () => {});\n", 'P019'],
  ];
  for (const [text, rule] of sources) {
    write(path.join(env.plugin, 'index.mjs'), text);
    const cliRules = mergeJudge(env.plugin, []).map((finding) => finding.ruleId);
    assert.ok(cliRules.includes(rule), `CLI missed ${rule}`);
    const runtime = liveWrite(env, 'index.mjs', text);
    assert.match(runtime, new RegExp(rule), `runtime missed ${rule}`);
  }

  /* legal sources produce no CLI finding and no runtime denial */
  const legal = "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nvoid require;\n";
  write(path.join(env.plugin, 'index.mjs'), legal);
  assert.deepEqual(mergeJudge(env.plugin, []).map((finding) => finding.ruleId), []);
  assert.equal(liveWrite(env, 'index.mjs', legal), undefined);
});

test('P013 broken syntax in a live plugin is denied, a valid rewrite passes', () => {
  const env = liveProfile();
  const broken = liveWrite(env, 'index.js', 'export function apply( {\n');
  assert.ok(broken, 'broken syntax must be refused');
  assert.match(broken, /P013/);
  assert.equal(liveWrite(env, 'index.js', 'export function apply() { return 1; }\n'), undefined);
});

test('P010 patch referencing an undeclared package is denied, a declared name passes', () => {
  const env = liveProfile();
  const unknown = profileWrite(env, 'cordis.patch.yml', '- insert:\n    - id: ghost\n      name: ghost-plugin\n');
  assert.match(unknown, /P010/);
  assert.equal(profileWrite(env, 'cordis.patch.yml', '- insert:\n    - id: p\n      name: plugin\n'), undefined);
});
