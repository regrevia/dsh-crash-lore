import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackage } from '../install-check/lib/signature.mjs'
import { compare } from '../install-check/lib/check.mjs'
import { render } from '../install-check/lib/report.mjs'
import { scanSkills, findSkillConflicts, skillRoots } from '../install-check/lib/skills.mjs'
import { renderSkills } from '../install-check/lib/report.mjs'
import { scanPackageClient } from '../install-check/lib/bundle.mjs'
import { renderTakeover, renderIncomplete } from '../install-check/lib/report.mjs'
import { checkInstall, apply, resetSkillWatch } from '../install-check/index.mjs'

const PATCH = ['- insert:', '    - id: alpha-memory', '      name: alpha-memory', ''].join('\n')

const ALPHA = {
  manifest: {
    name: 'alpha-memory',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
  files: {
    'cordis.patch.yml': PATCH,
    'index.js': [
      "export const inject = ['tools']",
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'save' }))",
      "  ctx.provide('memoryStore', {})",
      '}',
      '',
    ].join('\n'),
  },
}

const BETA = {
  manifest: {
    name: 'beta-memory',
    version: '2.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@scope/ghost': '^1.0.0' },
  },
  files: {
    'cordis.patch.yml': PATCH,
    'index.js': [
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'save too' }))",
      "  ctx.provide('memoryStore', {})",
      '}',
      '',
    ].join('\n'),
  },
}

async function fixture(parent, spec) {
  const dir = join(parent, spec.manifest.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(spec.manifest, null, 2))
  for (const [name, body] of Object.entries(spec.files)) {
    await writeFile(join(dir, name), body)
  }
  return dir
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'install-check-test-'))
  const alpha = await fixture(root, ALPHA)
  const beta = await fixture(root, BETA)
  return { root, alpha, beta }
}

test('reads tools, services and loader rows from source', async () => {
  const { alpha } = await workspace()
  const signature = scanPackage(alpha)
  assert.equal(signature.isPlugin, true)
  assert.deepEqual(signature.tools, ['memory_save'])
  assert.deepEqual(signature.services, ['memoryStore'])
  assert.deepEqual(signature.patchIds, ['alpha-memory'])
})

test('reports the exact keys that collide, plus missing peers', async () => {
  const { alpha, beta } = await workspace()
  const result = compare(scanPackage(beta), [scanPackage(alpha)])
  const kinds = result.findings.map((finding) => finding.kind).sort()
  assert.deepEqual(kinds, ['peer', 'row', 'service', 'tool'])
  assert.equal(result.breaks.length, 3)
  assert.equal(result.missing.length, 1)
  const tool = result.findings.find((finding) => finding.kind === 'tool')
  assert.deepEqual(tool.owners, ['alpha-memory'])
})

test('says what breaks and what to do about it', async () => {
  const { alpha, beta } = await workspace()
  const candidate = scanPackage(beta)
  const result = compare(candidate, [scanPackage(alpha)])
  const text = render(candidate, result)
  const zh = text.zh.split('\n')
  assert.equal(zh.length, 3)
  assert.match(zh[0], /^冲突：和 alpha-memory 用同一个工具名 memory_save，用同一个服务 memoryStore，装在同一个位置，两个只能留一个。$/)
  assert.match(zh[1], /^两个都想要，先停用 alpha-memory 再重启。$/)
  assert.match(zh[2], /^缺 @scope\/ghost，装上它之前这个插件起不来。$/)
  assert.match(text.en, /^Conflict:/)
  assert.doesNotMatch(text.zh, /模型只会看到一个|都注册工具|服务，后装的会顶掉/)
})

test('reads a colliding target end to end', async () => {
  const { root, alpha, beta } = await workspace()
  const profile = join(root, 'profile')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory'] } } }))
  await cp(alpha, join(profile, 'node_modules', 'alpha-memory'), { recursive: true })

  const decision = await checkInstall(
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: beta } },
    { profileDir: profile },
  )
  assert.equal(decision.result.findings.length, 4)
  assert.match(decision.text.zh, /alpha-memory/)
})

test('stays out of the way when the target is not a plugin', async () => {
  const { root } = await workspace()
  const plain = join(root, 'plain')
  await mkdir(plain, { recursive: true })
  await writeFile(join(plain, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }))
  const decision = await checkInstall({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: plain } })
  assert.equal(decision, null)
})

test('ignores calls that are not installs', async () => {
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }), null)
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'x', enabled: false } }), null)
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'x' } }), null)
})

const GAMMA = {
  manifest: {
    name: 'gamma-memory',
    version: '3.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
  files: {
    'cordis.patch.yml': ['- insert:', '    - id: gamma-memory', '      name: gamma-memory', ''].join('\n'),
    'index.js': [
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'same tool, nothing else' }))",
      '}',
      '',
    ].join('\n'),
  },
}

function fakeContext(extra = {}) {
  const handlers = {}
  return {
    handlers,
    ...extra,
    on(event, handler) {
      handlers[event] = handler
    },
    use() {},
    effect() {},
  }
}

async function profileWith(alpha) {
  const root = await mkdtemp(join(tmpdir(), 'install-check-hook-'))
  const profile = join(root, 'profile')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory'] } } }))
  await cp(alpha, join(profile, 'node_modules', 'alpha-memory'), { recursive: true })
  return profile
}

async function withProfile(profile, run) {
  const before = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = before
  }
}

test('never stops the install, notes the takeover afterwards', async () => {
  const { alpha, beta } = await workspace()
  const profile = await profileWith(alpha)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: beta } }
  const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'installed' }] })

  const before = await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, allow))
  assert.equal(before.kind, 'accept')

  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
  )
  assert.equal(after.content.length, 2)
  assert.match(after.content[1].text, /memoryStore/)
  assert.match(after.content[1].text, /停用 alpha-memory/)
})

test('lets a tool-name overlap install and appends the note', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: gamma } }
  const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'installed' }] })

  const before = await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, allow))
  assert.equal(before.kind, 'accept')

  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
  )
  assert.equal(after.content.length, 2)
  assert.match(after.content[1].text, /memory_save/)
})

async function skillDir(root, folder, frontmatter) {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`)
  return dir
}

const WORKBOOK = 'Format and validate a spreadsheet workbook, freeze header rows, add formulas, recalculate cached values'
const WORKBOOK_PDF = 'Format and validate a spreadsheet workbook, freeze header rows, add formulas, recalculate cached values, export to PDF'

test('two skills with one name: one of them never loads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  await skillDir(join(home, '.dsh', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report.')
  await skillDir(join(home, '.agents', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report with charts.')

  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 1)
  assert.equal(conflicts.names[0].name, 'weekly-report')
  assert.equal(conflicts.names[0].paths.length, 2)
  const zh = renderSkills(conflicts).zh.split('\n')
  assert.equal(zh.length, 1)
  assert.match(zh[0], /^冲突：两个 skill 都叫 weekly-report，只会生效一个。留一个，或给其中一个改名。$/)
  assert.match(renderSkills(conflicts).en, /^Conflict: two skills are both named weekly-report/)
})

test('two skills that answer the same requests: the model picks wrong', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'sheet-edit', `name: sheet-edit\ndescription: ${WORKBOOK}.`)
  await skillDir(root, 'print-sheet', `name: print-sheet\ndescription: ${WORKBOOK_PDF}.`)
  await skillDir(root, 'salsa', 'name: salsa\ndescription: Write dance choreography notes for a salsa rehearsal.')

  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 0)
  assert.equal(conflicts.overlaps.length, 1)
  assert.deepEqual([conflicts.overlaps[0].a, conflicts.overlaps[0].b].sort(), ['print-sheet', 'sheet-edit'])
  const zh = renderSkills(conflicts).zh.split('\n')
  assert.equal(zh.length, 1)
  assert.match(zh[0], /^两个 skill 的描述相似：(sheet-edit|print-sheet) 和 (sheet-edit|print-sheet)，建议检查触发边界。$/)
})

test('two versions of one skill are not a conflict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'tool-stable', `name: tool-stable\ndescription: ${WORKBOOK}.`)
  await skillDir(root, 'tool-next', `name: tool-next\ndescription: ${WORKBOOK_PDF}.`)
  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.overlaps.length, 0)
})

test('distinct skills stay quiet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.dsh', 'skills')
  await skillDir(root, 'deploy', 'name: deploy\ndescription: Ship the current branch to the staging cluster.')
  await skillDir(root, 'invoice', 'name: invoice\ndescription: Reconcile supplier invoices against the ledger.')
  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 0)
  assert.equal(conflicts.overlaps.length, 0)
  assert.equal(renderSkills(conflicts).zh, '')
})

test('a dropped skill folder gets one note on the next tool result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-home-'))
  await skillDir(join(home, '.dsh', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report.')
  await skillDir(home, '.agents-placeholder', 'name: x\ndescription: x')

  const before = process.env.INSTALL_CHECK_HOME
  process.env.INSTALL_CHECK_HOME = home
  resetSkillWatch()
  try {
    const ctx = fakeContext()
    apply(ctx)
    const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'copied' }] })
    const quiet = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(quiet.content.length, 1)

    await skillDir(join(home, '.agents', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report with charts.')
    resetSkillWatch()
    const after = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(after.content.length, 2)
    assert.match(after.content[1].text, /两个 skill 都叫 weekly-report/)

    const again = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(again.content.length, 1)
  } finally {
    if (before === undefined) delete process.env.INSTALL_CHECK_HOME
    else process.env.INSTALL_CHECK_HOME = before
    resetSkillWatch()
  }
})

async function clientPackage(client) {
  const dir = await mkdtemp(join(tmpdir(), 'install-check-client-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'task-graph-like',
    version: '0.1.0',
    exports: { './client': './client.js' },
    dsh: { client: { inject: [], platform: 'web' } },
  }))
  await writeFile(join(dir, 'client.js'), client)
  return dir
}

test('a plugin that fills a guessed host container is flagged', async () => {
  const dir = await clientPackage([
    "const host = document.querySelector('[class*=\"centerCol\"]') ?? document.body",
    "const css = '.v{position:fixed;inset:0;z-index:200}'",
    'host.appendChild(view)',
    '',
  ].join('\n'))
  const hit = scanPackageClient(dir)
  assert.equal(hit?.pane, 'host')
  assert.match(renderTakeover().zh, /铺满全屏/)
})

test('a plugin that renders into a slot stays quiet', async () => {
  const dir = await clientPackage([
    "const css = '.v{position:absolute;inset:0}'",
    'ctx.slot.register("sidebar.right.pane.tab", () => view)',
    '',
  ].join('\n'))
  assert.equal(scanPackageClient(dir), null)
})

test('a range that excludes this version is a mismatch, not a guess', async () => {
  const { satisfies, versionVerdict } = await import('../install-check/lib/compat.mjs')
  assert.equal(satisfies('0.2.1-rc.3', '>=0.2.0-rc.1'), true)
  assert.equal(satisfies('0.2.1-rc.3', '^0.2.0'), true)
  assert.equal(satisfies('0.2.1-rc.3', '>=0.2.0-rc.2 || >=0.2.1-rc.2'), true)
  assert.equal(versionVerdict('0.2.1-rc.3', '^0.3.0'), 'below')
  assert.equal(versionVerdict('0.9.0', '^0.2.0'), 'above')
  assert.equal(versionVerdict('0.2.1-rc.3', 'workspace:*'), 'unknown')
  assert.equal(versionVerdict('0.2.1-rc.3', 'nightly'), 'unknown')
})

test('a plugin that needs a newer harness is named before the install lands', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const needsNew = await fixture(root, {
    manifest: { name: 'needs-new', version: '1.0.0', engines: { dsh: '^0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
    files: {
      'cordis.patch.yml': ['- insert:', '    - id: needs-new', '      name: needs-new', ''].join('\n'),
      'index.js': 'export const inject = []\nexport function apply() {}\n',
    },
  })
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.1-rc.3'
  resetShellVersion()
  try {
    const checked = await checkInstall(
      { name: 'plugin_manager', arguments: { action: 'install_bundle', target: needsNew } },
      { profileDir: profile },
    )
    assert.match(checked.text.zh, /版本对不上/)
    assert.match(checked.text.zh, /\^0\.3\.0/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})

test('after a harness update, installed plugins left behind are named once', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const alphaManifest = join(profile, 'node_modules', 'alpha-memory', 'package.json')
  const manifest = JSON.parse(await readFile(alphaManifest, 'utf8'))
  manifest.engines = { dsh: '^0.3.0' }
  await writeFile(alphaManifest, JSON.stringify(manifest))
  await writeFile(join(profile, '.install-check-version.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.9.0'
  resetShellVersion()
  try {
    const ctx = fakeContext()
    apply(ctx)
    const exec = { name: 'some_tool', arguments: {} }
    const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    const after = await withProfile(profile, () =>
      ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
    )
    const text = after.content.map((item) => item.text).join('\n')
    assert.match(text, /0\.9\.0/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})

async function postNote(profile, ctx) {
  return withProfile(profile, async () => {
    const exec = { name: 'some_tool', arguments: {} }
    const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    const decision = await ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow)
    return decision.content.map((item) => item.text).join('\n')
  })
}

test('the loader answer splits what broke from what is only waiting', async () => {
  const { inactive } = await import('../install-check/lib/loader.mjs')
  const entries = [
    { options: { name: 'alpha-memory' }, fiber: { state: 3 } },
    { options: { name: 'no-fiber-row' } },
    {
      options: { name: '@scope/waiting' },
      fiber: { state: 0, inject: { sidebarRight: {} }, ctx: { get: () => undefined } },
    },
    { options: { name: 'fine' }, fiber: { state: 0, inject: { tools: {} }, ctx: { get: () => ({}) } } },
    { options: { name: 'healthy' }, fiber: { state: 2 } },
    { options: { name: 'off-by-choice' }, disabled: true },
  ]
  assert.deepEqual(inactive({ loader: { entries: () => entries } }), {
    broken: ['alpha-memory'],
    waiting: ['waiting'],
    settling: true,
  })
  assert.equal(inactive({}), null)
})

test('an update names what broke, and says apart what only lost a dependency', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  await writeFile(join(profile, '.install-check-version.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
  await mkdir(join(profile, 'node_modules', 'waiting-dep'), { recursive: true })
  await writeFile(
    join(profile, 'node_modules', 'waiting-dep', 'package.json'),
    JSON.stringify({ name: 'waiting-dep', version: '1.0.0' }),
  )
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory', 'waiting-dep'] } } }),
  )

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const ctx = fakeContext({
      loader: {
        entries: () => [
          { options: { name: 'alpha-memory' }, fiber: { state: 3 } },
          {
            options: { name: 'waiting-dep' },
            fiber: { state: 0, inject: { sidebarRight: {} }, ctx: { get: () => undefined } },
          },
          { options: { name: 'not-installed' }, fiber: { state: 3 } },
        ],
      },
    })
    apply(ctx)
    const text = await postNote(profile, ctx)
    assert.match(text, /升级后起不来：alpha-memory/)
    assert.match(text, /升级后没接上：waiting-dep/)
    assert.doesNotMatch(text, /not-installed/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('a first sighting still reports what is not running, and an unchanged version stays quiet', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const ctx = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(ctx)
    assert.match(await postNote(profile, ctx), /升级后起不来：alpha-memory/)

    const quiet = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(quiet)
    assert.equal(await postNote(profile, quiet), 'ok')
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('the official default decision still gets the note', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-1', arguments: { action: 'install_bundle', target: gamma } }
  // The host's own default: accept the original result, no content copied.
  const accept = async () => ({ kind: 'accept' })
  const original = [{ type: 'text', text: 'installed' }]

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, accept))
  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: original }, accept),
  )
  assert.equal(after.content.length, 2)
  assert.equal(after.content[0].text, 'installed')
  assert.match(after.content[1].text, /memory_save/)
})

test('a reminder stays with its own call', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const accept = async () => ({ kind: 'accept' })
  const first = { name: 'plugin_manager', token: 'call-a', arguments: { action: 'install_bundle', target: gamma } }
  // Another tool whose arguments happen to carry the same target.
  const other = { name: 'read_file', token: 'call-b', arguments: { target: gamma } }

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](first, accept))

  const stray = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](other, { isError: false, content: [] }, accept),
  )
  assert.equal(stray.content, undefined)

  const second = { name: 'plugin_manager', token: 'call-c', arguments: { action: 'install_bundle', target: gamma } }
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](second, accept))
  const own = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](first, { isError: false, content: [] }, accept),
  )
  assert.match(JSON.stringify(own.content), /memory_save/)
})

test('a decision that replaces the value is left alone', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-v', arguments: { action: 'install_bundle', target: 'x' } }
  const replace = async () => ({ kind: 'accept', value: { ok: true } })
  const after = await ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, replace)
  assert.deepEqual(after, { kind: 'accept', value: { ok: true } })
})

test('checking a Git target never runs its prepare script', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { existsSync } = await import('node:fs')
  const { materialize } = await import('../install-check/lib/materialize.mjs')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'install-check-git-'))
  const marker = join(root, 'prepare-ran')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'candidate',
      version: '1.0.0',
      scripts: { prepare: "node -e \"require('fs').writeFileSync('prepare-ran','x')\"" },
    }),
  )
  await writeFile(join(root, 'index.js'), 'export const x = 1\n')
  try {
    try {
      await run('git', ['init', '-q'], { cwd: root })
    } catch {
      return // no git on this machine: nothing to prove here
    }
    await run('git', ['add', '-A'], { cwd: root })
    await run('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: root })
    const packed = await materialize(`git+file://${root}`, { timeoutMs: 60000 })
    try {
      assert.equal(existsSync(marker), false, 'the candidate build script ran during a read-only check')
      assert.ok(existsSync(join(packed.dir, 'package.json')), 'the packed candidate could not be read')
    } finally {
      await packed.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a loader that is still moving is not called broken', async () => {
  const { inactive } = await import('../install-check/lib/loader.mjs')
  const entries = [
    { options: { name: 'coming-up' }, fiber: { state: 1 } },
    { options: { name: 'going-down' }, fiber: { state: 5 } },
    { options: { name: 'no-fiber-row' } },
    { options: { name: 'healthy' }, fiber: { state: 2 } },
  ]
  assert.deepEqual(inactive({ loader: { entries: () => entries } }), {
    broken: [],
    waiting: [],
    settling: true,
  })
})

test('a build without a loader does not consume the first sighting', async () => {
  const { existsSync } = await import('node:fs')
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const state = join(profile, '.install-check-version.json')

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const blind = fakeContext()
    apply(blind)
    assert.equal(await postNote(profile, blind), 'ok')
    assert.equal(JSON.parse(await readFile(state, 'utf8')).loader, false, 'an unreadable loader must not count as checked')

    const seeing = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(seeing)
    assert.match(await postNote(profile, seeing), /升级后起不来：alpha-memory/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('declared ranges follow the host rules', async () => {
  const { versionVerdict } = await import('../install-check/lib/compat.mjs')
  const cases = [
    ['1.9.0', '~1.2.3', 'above'],
    ['1.3.0', '^1.2', 'ok'],
    ['1.5.4', '1.2 - 1.5', 'ok'],
    ['0.2.1', '^0.3', 'below'],
    ['0.2.1', '^0.2.0', 'ok'],
    ['0.3.0', '^0.2.0', 'above'],
    ['1.2.3', '>=1.0.0 <2', 'ok'],
    ['2.0.0', '>=1.0.0 <2', 'above'],
    ['1.2.4', '1.2.3', 'above'],
    ['1.3.0', '~1.2', 'above'],
    ['0.2.1-rc.3', '^0.2.0', 'ok'],
  ]
  for (const [version, range, want] of cases) {
    assert.equal(versionVerdict(version, range), want, `${version} vs ${range}`)
  }
})

test('a change the host refused gets no advice about it', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-refused', arguments: { action: 'install_bundle', target: gamma } }
  const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'failed' }] })
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, accept))
  const result = { isError: false, content: [{ type: 'text', text: 'failed' }], value: JSON.stringify({ application: 'failed' }) }
  const after = await withProfile(profile, () => ctx.handlers['tools/post-execute'](exec, result, accept))
  assert.deepEqual(after.content, [{ type: 'text', text: 'failed' }])

  const kept = { name: 'plugin_manager', token: 'call-kept', arguments: { action: 'install_bundle', target: gamma } }
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](kept, accept))
  const applied = { isError: false, content: [{ type: 'text', text: 'installed' }], value: JSON.stringify({ application: 'applied' }) }
  const withNote = await withProfile(profile, () => ctx.handlers['tools/post-execute'](kept, applied, accept))
  assert.equal(withNote.content.length, 2)
  assert.match(withNote.content[1].text, /memory_save/)
})

test('the profile the host launched wins over the environment', async () => {
  const { existsSync } = await import('node:fs')
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const elsewhere = join(root, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })

  const before = process.env.DSH_SHELL_VERSION
  const beforeDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_SHELL_VERSION = '0.2.2'
  process.env.DSH_PROFILE_DIR = elsewhere
  resetShellVersion()
  try {
    const ctx = fakeContext({
      get: (name) => (name === 'profileContext' ? { dir: profile } : undefined),
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(ctx)
    assert.match(await postNote(profile, ctx), /升级后起不来：alpha-memory/)
    assert.equal(existsSync(join(elsewhere, '.install-check-version.json')), false)
    assert.equal(existsSync(join(profile, '.install-check-version.json')), true)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    if (beforeDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = beforeDir
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('a patch that only edits an existing row does not claim it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-row-'))
  try {
    const override = join(root, 'override')
    const insert = join(root, 'insert')
    const second = join(root, 'second')
    const edit = join(root, 'edit')
    for (const [dir, patch] of [
      [override, ['- id: shared-row', '  name: alpha-memory', ''].join('\n')],
      [insert, ['- insert:', '    - id: shared-row', '      name: alpha-memory', ''].join('\n')],
      [edit, ['- id: shared-row', '  name: beta-memory', ''].join('\n')],
      [second, ['- insert:', '    - id: shared-row', '      name: beta-memory', ''].join('\n')],
    ]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: dir.split('/').pop(), version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await writeFile(join(dir, 'cordis.patch.yml'), patch)
    }
    const installed = await scanPackage(insert)
    const edited = await scanPackage(edit)
    const added = await scanPackage(override)
    const rival = await scanPackage(second)
    assert.deepEqual(installed.patchInserts, ['shared-row'])
    assert.deepEqual(edited.patchInserts, [])
    assert.deepEqual(edited.patchOverrides, ['shared-row'])
    // Two overrides of the same row are an edit, not a collision.
    assert.equal(compare(added, [edited]).breaks.length, 0)
    // An insert that overlaps another insert is.
    assert.equal(compare(rival, [installed]).breaks.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an optional peer is not a missing dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-opt-'))
  try {
    const dir = join(root, 'opt')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'opt-memory',
        version: '1.0.0',
        peerDependencies: { '@scope/nice-to-have': '^1.0.0', '@scope/needed': '^1.0.0' },
        peerDependenciesMeta: { '@scope/nice-to-have': { optional: true } },
      }),
    )
    await writeFile(join(dir, 'index.js'), 'export function apply(ctx) {}\n')
    const candidate = await scanPackage(dir)
    const result = compare(candidate, [])
    assert.deepEqual(result.missing.map((hit) => hit.key), ['@scope/needed'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('routes collide only on the same kind and path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-route-'))
  try {
    const make = async (name, route) => {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      await writeFile(join(dir, 'index.js'), `export function apply(ctx) {\n  ctx.effect(() => ctx.webServer.register({\n    kind: '${route.kind}',\n    path: '${route.path}',\n    handler: () => {},\n  }))\n}\n`)
      return scanPackage(dir)
    }
    const exact = await make('route-exact', { kind: 'exact', path: '/api/one' })
    const prefix = await make('route-prefix', { kind: 'prefix', path: '/api/one' })
    const same = await make('route-same', { kind: 'exact', path: '/api/one' })
    assert.deepEqual(exact.routes, ['exact:/api/one'])
    // One exact and one prefix route on the same path are two seats.
    assert.equal(compare(prefix, [exact]).breaks.length, 0)
    // Two exact routes on the same path are one seat claimed twice.
    const result = compare(same, [exact])
    assert.equal(result.breaks.length, 1)
    assert.match(render(same, result).zh, /抢同一个地址.*\/api\/one/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a shared tool name reads as an override, not a broken install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-'))
  try {
    const make = async (name, tool) => {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      await writeFile(join(dir, 'index.js'), `export function apply(ctx) {\n  ctx.tools.register(defineTool({ name: '${tool}', description: 'x' }))\n}\n`)
      return scanPackage(dir)
    }
    const first = await make('tool-a', 'memory_save')
    const second = await make('tool-b', 'memory_save')
    const result = compare(second, [first])
    assert.equal(result.breaks.length, 1)
    assert.match(render(second, result).zh, /同名工具/)
    assert.doesNotMatch(render(second, result).zh, /只能留一个/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a block scalar description is still read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'sheet-edit', `name: sheet-edit\ndescription: >\n  ${WORKBOOK}.\n  Use for any workbook work.`)
  await skillDir(root, 'print-sheet', `name: print-sheet\ndescription: |\n  ${WORKBOOK_PDF}.\n  Use for any workbook work.`)

  const skills = scanSkills(skillRoots(home))
  assert.equal(skills.length, 2)
  const conflicts = findSkillConflicts(skills)
  assert.equal(conflicts.overlaps.length, 1)
})

test('two Chinese descriptions that answer the same requests overlap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'zhoubao', 'name: zhoubao\ndescription: 生成每周销售报表，汇总各区域数据并导出图表。')
  await skillDir(root, 'sales-chart', 'name: sales-chart\ndescription: 生成每周销售报表，汇总各区域数据并导出图表和明细页。')
  await skillDir(root, 'salsa', 'name: salsa\ndescription: 记录萨尔萨舞排练的编排笔记。')

  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.overlaps.length, 1)
  assert.deepEqual([conflicts.overlaps[0].a, conflicts.overlaps[0].b].sort(), ['sales-chart', 'zhoubao'])
})

test('a route is read only from the call that registers it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-check-route-'))
  const dir = join(root, 'route-plugin')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'route-plugin', version: '1.0.0' }))
  await writeFile(join(dir, 'index.js'), [
    "const KIND = { kind: 'prefix' }",
    "const WHERE = { path: '/one' }",
    "const TABLE = { kind: 'prefix', path: '/data' }",
    "// ctx.webServer.register({ kind: 'prefix', path: '/commented' })",
    'export function apply(ctx) {',
    '  ctx.webServer.register(KIND, WHERE)',
    '  ctx.webServer.register({ kind: RELATIVE_KIND })',
    "  ctx.webServer.register({ kind: 'exact', path: '/real' })",
    '}',
    '',
  ].join('\n'))
  assert.deepEqual(scanPackage(dir).routes, ['exact:/real'])
})

test('a name on some other object is not a tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-check-tool-'))
  const dir = join(root, 'tool-plugin')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tool-plugin', version: '1.0.0' }))
  await writeFile(join(dir, 'index.js'), [
    'export function apply(ctx) {',
    "  const labels = { name: 'not_a_tool' }",
    "  // ctx.tools.register(defineTool({ name: 'commented_out' }))",
    "  ctx.tools.register(defineTool({ name: 'memory_search', description: 'real' }))",
    "  ctx.webServer.register({ kind: 'exact', path: '/x', name: '/not-a-tool' })",
    '}',
    '',
  ].join('\n'))
  assert.deepEqual(scanPackage(dir).tools, ['memory_search'])
})

test('a per-agent tool reads as a possible override, not a broken install', async () => {
  const { root, alpha } = await workspace()
  const scoped = await fixture(root, {
    manifest: { name: 'scoped-memory', version: '1.0.0' },
    files: {
      'index.js': [
        'export function apply(ctx) {',
        "  ctx.agent.ctx.tools.register(defineTool({ name: 'memory_save', description: 'only for one agent' }))",
        '}',
        '',
      ].join('\n'),
    },
  })
  const candidate = scanPackage(scoped)
  assert.deepEqual(candidate.scopedTools, ['memory_save'])
  const result = compare(candidate, [scanPackage(alpha)])
  assert.equal(result.breaks[0].certain, false)
  const text = render(candidate, result)
  assert.match(text.zh, /可能有一个起不来/)
  assert.doesNotMatch(text.zh, /后装的那个起不来/)
})

test('an install run from a program still gets its note', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ran' }] })
  const outer = { name: 'run_code', token: 'root-1', arguments: { code: 'await tools.plugin_manager()' } }
  const sub = {
    name: 'plugin_manager',
    token: 'root-1:ptc:1',
    rootCallId: 'root-1',
    parent: 'root-1',
    arguments: { action: 'install_bundle', target: gamma },
  }

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](sub, accept))
  const decision = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](sub, { isError: false, value: 'installed' }, accept),
  )
  assert.equal(decision.content.length, 1)
  assert.equal(decision.additionalContexts.length, 1)
  assert.equal(decision.additionalContexts[0].role, 'user')
  assert.match(decision.additionalContexts[0].content[0].text, /memory_save/)
  assert.ok(outer.token)
})

test('a row whose import failed is named, a composition row is not', async () => {
  const { inactive } = await import('../install-check/lib/loader.mjs')
  const running = { ctx: { fiber: { uid: 7 } } }
  const entries = [
    { options: { name: 'failed-import' }, parent: running },
    { options: { name: 'group-row' }, parent: { ctx: {} } },
    { options: { name: 'disposed' }, parent: running, fiber: { state: 4 } },
    { options: { name: 'healthy' }, parent: running, fiber: { state: 2 } },
  ]
  assert.deepEqual(inactive({ loader: { entries: () => entries } }), {
    broken: ['failed-import', 'disposed'],
    waiting: [],
    settling: false,
  })
})

test('enabling a package that collides is flagged before it turns on', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const beta = await fixture(root, {
    manifest: { name: 'beta-memory', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
    files: {
      'cordis.patch.yml': ['- insert:', '    - id: beta-memory', '      name: beta-memory', ''].join('\n'),
      'index.js': [
        'export function apply(ctx) {',
        "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'same name' }))",
        '}',
        '',
      ].join('\n'),
    },
  })
  await cp(beta, join(profile, 'node_modules', 'beta-memory'), { recursive: true })
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'enable-1', arguments: { action: 'set_bundle', enabled: true, target: 'beta-memory' } }
  const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'enabled' }] })

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, accept))
  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, accept),
  )
  const text = after.content.map((item) => item.text).join('\n')
  assert.match(text, /memory_save/)
})

test('a loader still moving keeps its answer open for the next look', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  await writeFile(join(profile, '.install-check-version.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const moving = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 1 } }] },
    })
    apply(moving)
    assert.equal(await postNote(profile, moving), 'ok')

    const settled = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(settled)
    assert.match(await postNote(profile, settled), /升级后起不来：alpha-memory/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('an install clears what the old file said about the packages', async () => {
  const { checkInstall } = await import('../install-check/index.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: gamma } }

  const first = await checkInstall(exec, { profileDir: profile })
  assert.match(first.text.zh, /memory_save/)

  await writeFile(
    join(profile, 'node_modules', 'alpha-memory', 'index.js'),
    'export function apply() {}\n',
  )

  const ctx = fakeContext()
  apply(ctx)
  await ctx.handlers['tools/post-execute'](
    { name: 'plugin_manager', token: 'install-2', arguments: { action: 'install_bundle', target: gamma } },
    { isError: false, content: [] },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: 'installed' }] }),
  )

  assert.equal(await checkInstall(exec, { profileDir: profile }), null)
})

test('a partial ceiling covers the whole range it names', async () => {
  const { satisfies } = await import('../install-check/lib/compat.mjs')
  assert.equal(satisfies('1.5.0', '<=1'), true)
  assert.equal(satisfies('2.0.0', '<=1'), false)
  assert.equal(satisfies('1.2.9', '<=1.2'), true)
  assert.equal(satisfies('1.3.0', '<=1.2'), false)
  assert.equal(satisfies('1.2.3', '<=1.2.3'), true)
  assert.equal(satisfies('1.2.4', '<=1.2.3'), false)
  assert.equal(satisfies('0.2.1-rc.3', '>=0.2.0-rc.1'), true)
  assert.equal(satisfies('1.0.0', '>=0.2.0-rc.1'), true)
})

test('a skill folder reached through a link is still a skill', async () => {
  const { root } = await workspace()
  const home = join(root, 'home')
  const real = join(root, 'real-skill')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'SKILL.md'), '---\nname: linked-skill\ndescription: does one thing\n---\n')
  const linked = join(home, '.dsh', 'skills')
  await mkdir(linked, { recursive: true })
  await symlink(real, join(linked, 'linked-skill'))
  const { scanSkills } = await import('../install-check/lib/skills.mjs')
  const skills = scanSkills([linked])
  assert.deepEqual(skills.map((skill) => skill.name), ['linked-skill'])
})

test('two skills that differ by more than a version marker are compared', async () => {
  const { findSkillConflicts } = await import('../install-check/lib/skills.mjs')
  const words = new Set(['build', 'page', 'layout', 'preview', 'render', 'export', 'screenshot', 'device'])
  const conflicts = findSkillConflicts([
    { name: 'ui-review', file: 'a', words },
    { name: 'ui-preview', file: 'b', words },
    { name: 'sandbox-next', file: 'c', words: new Set(['sandbox', 'preview', 'edge', 'runtime', 'deploy', 'isolate', 'container', 'worker']) },
    { name: 'sandbox-stable', file: 'd', words: new Set(['sandbox', 'preview', 'edge', 'runtime', 'deploy', 'isolate', 'container', 'worker']) },
  ])
  assert.deepEqual(conflicts.overlaps.map((hit) => [hit.a, hit.b].sort()), [['ui-preview', 'ui-review']])
})

test('a check that could not finish says so instead of staying quiet', async () => {
  assert.match(renderIncomplete('not-found').zh, /^没检查完：.*看一眼有没有报错。$/)
  assert.match(renderIncomplete('network').en, /^Check unfinished: /)
  assert.match(renderIncomplete('slow').zh, /没检查完/)
  assert.match(renderIncomplete('unknown').zh, /^没检查完，装完看一眼有没有报错。$/)
})

test('an edited package is read again, not remembered', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: gamma } }
  const first = await checkInstall(exec, { profileDir: profile })
  assert.match(first.text.zh, /memory_save/)

  await writeFile(
    join(profile, 'node_modules', 'alpha-memory', 'index.js'),
    "export function apply(ctx) {\n  ctx.tools.register(defineTool({ name: 'memory_recall', description: 'save' }))\n}\n",
  )
  const second = await checkInstall(exec, { profileDir: profile })
  assert.equal(second, null)
})

test('a package already in the profile is read in place', async () => {
  const { alpha } = await workspace()
  const profile = await profileWith(alpha)
  const started = Date.now()
  const checked = await checkInstall(
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'alpha-memory@1.0.0' } },
    { profileDir: profile },
  )
  assert.equal(checked, null)
  assert.ok(Date.now() - started < 5000)
})

test('a version rule the harness never reads stays quiet', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const quiet = await fixture(root, {
    manifest: {
      name: 'quiet-requirement',
      version: '1.0.0',
      dsh: { engines: { dsh: '^9.0.0' }, bundle: { patch: './cordis.patch.yml' } },
    },
    files: {
      'cordis.patch.yml': ['- insert:', '    - id: quiet-requirement', '      name: quiet-requirement', ''].join('\n'),
      'index.js': 'export const inject = []\nexport function apply() {}\n',
    },
  })
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.1-rc.3'
  resetShellVersion()
  try {
    const checked = await checkInstall(
      { name: 'plugin_manager', arguments: { action: 'install_bundle', target: quiet } },
      { profileDir: profile },
    )
    assert.equal(checked, null)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})

test('a harness peer range is read the way the harness reads it', async () => {
  const { resetShellVersion } = await import('../install-check/lib/shell.mjs')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const peer = await fixture(root, {
    manifest: {
      name: 'peer-requirement',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh': '^0.3.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    files: {
      'cordis.patch.yml': ['- insert:', '    - id: peer-requirement', '      name: peer-requirement', ''].join('\n'),
      'index.js': 'export const inject = []\nexport function apply() {}\n',
    },
  })
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.1-rc.3'
  resetShellVersion()
  try {
    const checked = await checkInstall(
      { name: 'plugin_manager', arguments: { action: 'install_bundle', target: peer } },
      { profileDir: profile },
    )
    assert.ok(checked)
    assert.match(checked.text.zh, /版本对不上/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})
