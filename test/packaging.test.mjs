import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/* 打包白名单漏一个模块，装进 profile 后就是 activate 阶段找不到模块——插件起不来，用户只看到
 * 「没生效」。这条测试把「相对 import 指向的文件真的会被发布」变成机器检查，不再靠人记得改 files。 */
const shippable = (rel) => {
  return pkg.files.some((pattern) => {
    if (pattern.includes('*')) {
      const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`);
      return rx.test(rel);
    }
    return pattern.endsWith('/') ? rel.startsWith(pattern) : rel === pattern;
  });
};

const entries = ['index.js', 'core.mjs', 'cli.mjs', 'watchdog.mjs', 'handoff.mjs', 'defense.mjs', 'guard.mjs', 'state.mjs', 'memory.mjs', 'doctor.mjs'];

test('every relative import of a shipped entry resolves to a file that is published', () => {
  const missing = [];
  for (const entry of entries) {
    const text = fs.readFileSync(path.join(root, entry), 'utf8');
    for (const match of text.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]));
      if (!fs.existsSync(path.join(root, target))) missing.push(`${entry} -> ${target}（文件不存在）`);
      else if (!shippable(target)) missing.push(`${entry} -> ${target}（没进 package.json files，装进 profile 后缺文件）`);
    }
  }
  assert.deepEqual(missing, []);
});

test('version in core.mjs matches package.json', () => {
  const core = fs.readFileSync(path.join(root, 'core.mjs'), 'utf8');
  const match = core.match(/export const VERSION = '([^']+)';/);
  assert.ok(match, 'core.mjs 里找不到 VERSION');
  assert.equal(match[1], pkg.version);
});
