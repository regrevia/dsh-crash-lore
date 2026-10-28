import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, checkSource } from '../guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.dirname(HERE);

function brokenPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pf-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'broken', version: '0.0.1', type: 'module', main: './index.js',
    exports: { '.': './index.js', './gone': './lib/gone.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: dup\n    - id: dup\n    - id: other\n      name: undeclared\n');
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "import fs from 'node:fs';",
    "const cfg = require('./cfg.json');",
    "throw new Error('boom');",
    'process.exit(0);',
    "const dir = __dirname;",
    "export const name = 'broken';",
    "export const inject = ['tools'];",
    'export function apply(ctx) {',
    "  ctx.tools.register({ name: 'Bad Name', parameters: {}, execute: async () => ({}) });",
    '}',
  ].join('\n'));
  return dir;
}

test('preflight catches the loader-level crash shapes', () => {
  const dir = brokenPlugin();
  const ids = preflight(dir).map((item) => item.ruleId);
  for (const expected of ['P006', 'P009', 'P010', 'P014', 'P016', 'P017', 'P018', 'P023', 'P025']) {
    assert.ok(ids.includes(expected), `expected ${expected} in ${ids.join(',')}`);
  }
  const blocking = preflight(dir).filter((item) => item.severity === 'fatal' || item.severity === 'boot');
  assert.ok(blocking.length >= 5, 'fatal/boot findings are what block an install');
});

test('preflight accepts a well-formed host plugin (no false positives on this one)', () => {
  const findings = preflight(PLUGIN).filter((item) => item.severity === 'fatal' || item.severity === 'boot');
  assert.deepEqual(findings.map((item) => `${item.ruleId} ${item.file}`), []);
});

test('checkSource still reports a passing source tree', () => {
  const findings = checkSource(path.join(PLUGIN, 'index.js').replace(/index\.js$/, ''), []);
  assert.equal(findings.length, 0);
});
