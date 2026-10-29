import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackage } from '../install-check/lib/signature.mjs'
import { capabilityWords, overlapFindings, renderOverlap } from '../install-check/lib/overlap.mjs'

const PATCH = ['- insert:', '    - id: one', '      name: one', ''].join('\n')

function spec(name, tools, slots = [], services = []) {
  return {
    manifest: {
      name,
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    files: {
      'cordis.patch.yml': PATCH,
      'index.js': [
        'export function apply(ctx) {',
        ...tools.map((tool) => `  ctx.tools.register(defineTool({ name: '${tool}' }))`),
        ...services.map((service) => `  ctx.provide('${service}', {})`),
        ...slots.map((slot) => `  ctx.slots.inject('${slot}', () => null)`),
        '}',
        '',
      ].join('\n'),
    },
  }
}

async function scan(item) {
  const root = await mkdtemp(join(tmpdir(), 'overlap-test-'))
  const dir = join(root, item.manifest.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(item.manifest, null, 2))
  for (const [name, body] of Object.entries(item.files)) {
    await writeFile(join(dir, name), body)
  }
  return scanPackage(dir)
}

test('capability words drop generic verbs and split names', async () => {
  const signature = await scan(spec('alpha', ['memory_save_note', 'browser_open_page', 'list_files']))
  const words = capabilityWords(signature)
  assert.ok(words.includes('memory'))
  assert.ok(words.includes('browser'))
  assert.ok(!words.includes('list'))
  assert.ok(!words.includes('files'))
})

test('same function under a different name is reported', async () => {
  const candidate = await scan(spec('alpha', ['memory_save_note']))
  const installed = await scan(spec('beta', ['memory_recall_note']))
  const findings = overlapFindings(candidate, [installed])
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'capability')
  assert.equal(findings[0].other, 'beta')
  assert.deepEqual(findings[0].shared.sort(), ['memory', 'note'])
  assert.match(findings[0].zh, /beta/)
  assert.match(findings[0].zh, /功能重叠/)
  assert.match(findings[0].en, /Overlaps with beta/)
})

test('two packages putting something in one slot outrank capability overlap', async () => {
  const candidate = await scan(spec('alpha', ['memory_save'], ['sidebar.right']))
  const installed = await scan(spec('beta', ['memory_recall'], ['sidebar.right']))
  const findings = overlapFindings(candidate, [installed])
  assert.equal(findings[0].kind, 'slot')
  assert.match(findings[0].zh, /sidebar\.right/)
  assert.ok(findings.some((finding) => finding.kind === 'capability'))
})

test('a camelCase tool name is still a tool', async () => {
  const one = await scan(spec('camel-use', ['browserOpenPage']))
  const other = await scan(spec('snake-use', ['browser_open_page']))
  assert.deepEqual(one.tools, ['browserOpenPage'])
  assert.ok(capabilityWords(one).includes('browser'))
  assert.deepEqual(overlapFindings(one, [other]).map((hit) => hit.kind), ['capability'])
})

test('a tool registered through a helper is still a tool', async () => {
  const one = await scan({
    manifest: { name: 'wrapped-use', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
    files: {
      'cordis.patch.yml': PATCH,
      'index.js': [
        'export function apply(ctx) {',
        "  ctx.tools.register(withOutput({ name: 'memoryZettel', execute() {} }))",
        '}',
        '',
      ].join('\n'),
    },
  })
  assert.deepEqual(one.tools, ['memoryZettel'])
})

test('unrelated packages report nothing', async () => {
  const candidate = await scan(spec('alpha', ['memory_save']))
  const installed = await scan(spec('beta', ['browser_navigate']))
  assert.deepEqual(overlapFindings(candidate, [installed]), [])
  assert.equal(renderOverlap([]), null)
})

test('a package is not compared with itself', async () => {
  const candidate = await scan(spec('alpha', ['memory_save']))
  assert.deepEqual(overlapFindings(candidate, [candidate]), [])
})

test('at most three findings, loudest first', async () => {
  const candidate = await scan(spec('alpha', ['memory_save_note'], ['sidebar.right']))
  const installed = await Promise.all([
    scan(spec('beta', ['memory_recall'])),
    scan(spec('gamma', ['note_dump'])),
    await scan(spec('delta', ['memory_note_scan'], ['sidebar.right'])),
  ])
  const findings = overlapFindings(candidate, installed)
  assert.ok(findings.length <= 3)
  assert.equal(findings[0].other, 'delta')
})

test('a non-plugin is never compared', async () => {
  const candidate = await scan(spec('alpha', ['memory_save']))
  candidate.isPlugin = false
  const installed = await scan(spec('beta', ['memory_recall']))
  assert.deepEqual(overlapFindings(candidate, [installed]), [])
})
