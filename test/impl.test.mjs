import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { implementationRisks, renderImplementation } from '../install-check/lib/impl.mjs'

const PATCH = ['- insert:', '    - id: pkg', '      name: pkg', ''].join('\n')

async function plugin(files) {
  const root = await mkdtemp(join(tmpdir(), 'impl-test-'))
  const dir = join(root, 'pkg')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'pkg',
    version: '1.0.0',
    dependencies: { pkg: '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(dir, 'cordis.patch.yml'), PATCH)
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body)
  return dir
}

test('a plugin that kills the process is called out before it lands', async () => {
  const dir = await plugin({
    'index.js': ['export function apply(ctx) {', '  ctx.on("ready", () => process.exit(0))', '}', ''].join('\n'),
  })
  const risks = implementationRisks(dir)
  assert.equal(risks.length, 1)
  assert.equal(risks[0].ruleId, 'P018')
  assert.match(risks[0].zh, /process\.exit|退出/)
  assert.match(risks[0].en, /index\.js:2/)
})

test('a module that throws on load is reported with its line', async () => {
  const dir = await plugin({
    'index.js': ['const broken = 1', 'throw new Error("nope")', ''].join('\n'),
  })
  const risks = implementationRisks(dir)
  assert.equal(risks[0].ruleId, 'P014')
  assert.equal(risks[0].line, 2)
})

test('a clean plugin reports nothing', async () => {
  const dir = await plugin({
    'index.js': ['export const inject = ["tools"]', 'export function apply(ctx) {}', ''].join('\n'),
  })
  assert.deepEqual(implementationRisks(dir), [])
  assert.equal(renderImplementation([]), null)
})

test('at most two findings, and the rest is counted not listed', async () => {
  const dir = await plugin({
    'a.js': 'process.exit(1)\n',
    'b.js': 'throw new Error("x")\n',
    'c.js': 'await Promise.resolve()\n',
  })
  const risks = implementationRisks(dir)
  assert.equal(risks.length, 2)
  assert.match(risks[1].zh, /另有 1 处/)
})

test('unreadable input never throws', async () => {
  assert.deepEqual(implementationRisks(null), [])
  assert.deepEqual(implementationRisks(join(tmpdir(), 'does-not-exist-impl-test')), [])
})
