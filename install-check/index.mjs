/**
 * 插件无忧装 — 装之前看一眼。
 *
 * Purely call-triggered: it only listens for plugin_manager's install calls.
 * It never guesses intent from what the user said.
 *
 * A change may go live without a restart, so this note can arrive after the
 * plugin already runs; it still never stops an install. Asking first would
 * cost a round trip, and where approvals are unavailable an ask degrades into
 * a refusal.
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { scanPackage } from './lib/signature.mjs'
import { compare } from './lib/check.mjs'
import {
  render,
  renderBroken,
  renderSkills,
  renderTakeover,
  renderUnconnected,
  renderIncomplete,
  renderVersion,
  renderVersionAudit,
} from './lib/report.mjs'
import { readRules } from '../core.mjs'
import { implementationRisks, renderImplementation } from './lib/impl.mjs'
import { overlapFindings, renderOverlap } from './lib/overlap.mjs'
import { satisfies, versionVerdict } from './lib/compat.mjs'
import { declaredRanges, shellVersion } from './lib/shell.mjs'
import { inactive } from './lib/loader.mjs'
import { scanPackageClient } from './lib/bundle.mjs'
import { Incomplete, materialize } from './lib/materialize.mjs'
import { fingerprint, findSkillConflicts, scanSkills, skillRoots } from './lib/skills.mjs'

export const name = 'install-check'
export const inject = ['tools']

const ALTERNATE = new Set(['workspace:^', 'workspace:~', 'workspace:*'])
const TTL = 30 * 60_000
const SKILL_TTL = 3_000
const scanCache = new Map()
const pending = new Map()

/** Skills arrive as files, so they are noticed on the first tool call after the change. */
const skillState = { checkedAt: 0, seen: null, told: new Set() }

function skillNote() {
  const now = Date.now()
  if (now - skillState.checkedAt < SKILL_TTL) return null
  skillState.checkedAt = now

  const roots = skillRoots()
  const print = fingerprint(roots)
  if (print === skillState.seen) return null
  skillState.seen = print

  const conflicts = findSkillConflicts(scanSkills(roots))
  const names = conflicts.names.filter((hit) => !skillState.told.has(`name:${hit.name}`))
  const overlaps = conflicts.overlaps.filter((hit) => !skillState.told.has(`overlap:${hit.a}|${hit.b}`))
  if (!names.length && !overlaps.length) return null

  for (const hit of names) skillState.told.add(`name:${hit.name}`)
  for (const hit of overlaps) skillState.told.add(`overlap:${hit.a}|${hit.b}`)
  return renderSkills({ names, overlaps }).zh
}

function profileDir(ctx) {
  // The running profile knows its own directory; env vars are only a fallback
  // for callers outside one.
  try {
    const dir = ctx?.get?.('profileContext')?.dir
    if (typeof dir === 'string' && dir) return dir
  } catch {
    // fall through to the environment
  }
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return explicit
  const profile = process.env.DSH_PROFILE
  if (profile) return join(homedir(), '.dsh', 'profiles', profile)
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}

/** Rules this machine learned from its own crash logs; empty until it has learned some. */
function learnedRules() {
  try {
    return readRules()
  } catch {
    return []
  }
}

/** Files edited in place keep their path, so the fingerprint is what can change. */
function stamp(dir) {
  const parts = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true }).slice(0, 64)) {
      if (!entry.isFile()) continue
      try {
        parts.push(`${entry.name}:${statSync(join(dir, entry.name)).mtimeMs}`)
      } catch {
        // a file that vanished mid-read is not worth a retry
      }
    }
  } catch {
    return null
  }
  return parts.join('|')
}

function scanCached(dir) {
  const held = scanCache.get(dir)
  const now = Date.now()
  if (held && now - held.at < TTL) {
    const current = stamp(dir)
    // The same path with different bytes is a different package.
    if (current !== null && current === held.stamp) return held.signature
  }
  const signature = scanPackage(dir)
  scanCache.set(dir, { at: Date.now(), signature, stamp: stamp(dir) })
  return signature
}

function patchNames(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const patch = manifest?.dsh?.bundle?.patch
    if (!patch) return []
    const text = readFileSync(join(dir, patch), 'utf8')
    return [...text.matchAll(/^\s*-?\s*name:\s*['"]?(@?[\w@/.:-]+)['"]?\s*$/gm)].map((match) => match[1])
  } catch {
    return []
  }
}

/** Every package directory the live profile would load, including bundle rows. */
function installedDirs(profile) {
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const seen = new Set()
  const dirs = []
  const add = (packageName) => {
    if (!packageName || seen.has(packageName)) return
    const dir = join(profile, 'node_modules', packageName)
    if (!existsSync(join(dir, 'package.json'))) return
    seen.add(packageName)
    dirs.push(dir)
  }

  for (const bundle of bundles) {
    const dir = join(profile, 'node_modules', bundle)
    add(bundle)
    for (const name of patchNames(dir)) add(name)
  }
  return dirs
}

function installedPackages(profile) {
  return installedDirs(profile).map(scanCached)
}

/**
 * A harness update can leave installed plugins behind. Their declared range is
 * read again the first time the version changes, and the loader is asked the
 * same question, so a plugin that silently failed to come up is named too.
 */
async function versionAudit(ctx) {
  const version = shellVersion()
  if (!version) return null
  const profile = profileDir(ctx)
  const file = join(profile, '.install-check-version.json')
  let state = null
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    state = null
  }
  const seen = state?.version === version ? state : null
  // The range and the loader are remembered separately: a build that cannot
  // read one of them must not stop the other from being reported later.
  const needRange = !seen?.range
  const needLoader = !seen?.loader
  if (!needRange && !needLoader) return null

  const live = inactive(ctx)
  if (live === null && !needRange) return null

  const dirs = installedDirs(profile)
  const installed = new Set(dirs.map((dir) => basename(dir)))
  const previous = typeof state?.version === 'string' ? state.version : null
  const stale = []
  // A declared range can only be compared once there is a previous version to
  // compare with; the loader needs no baseline, so a first sighting still reports
  // what is not running right now.
  if (needRange && previous) {
    for (const dir of dirs) {
      // The harness reads `workspace:` shorthands as "this build", so they can
      // never be out of range.
      const unmet = (declaredRanges(dir) ?? []).filter(({ range }) => !ALTERNATE.has(range))
      if (unmet.some(({ range }) => ['below', 'above'].includes(versionVerdict(version, range)))) {
        stale.push(basename(dir))
      }
    }
  }
  const mine = (name) => installed.has(name) && !stale.includes(name)
  const broken = live ? live.broken.filter(mine) : []
  const waiting = live ? live.waiting.filter((name) => mine(name) && !broken.includes(name)) : []

  // Same plugin, same version, same complaint: say it once. A loader that is
  // still moving is asked again next time instead of being written down as done.
  const told = seen?.told && typeof seen.told === 'object' ? seen.told : {}
  const fresh = (names, issue) => names.filter((name) => !String(told[name] ?? '').split(',').includes(issue))
  const staleFresh = fresh(stale, 'stale')
  const brokenFresh = fresh(broken, 'broken')
  const waitingFresh = fresh(waiting, 'waiting')

  const lines = []
  if (staleFresh.length) lines.push(renderVersionAudit(staleFresh, version).zh)
  if (brokenFresh.length) lines.push(renderBroken(brokenFresh).zh)
  if (waitingFresh.length) lines.push(renderUnconnected(waitingFresh).zh)

  const nextTold = { ...told }
  const remember = (names, issue) => {
    for (const name of names) {
      const issues = new Set(String(nextTold[name] ?? '').split(',').filter(Boolean))
      issues.add(issue)
      nextTold[name] = [...issues].join(',')
    }
  }
  remember(staleFresh, 'stale')
  remember(brokenFresh, 'broken')
  remember(waitingFresh, 'waiting')

  try {
    writeFileSync(
      file,
      JSON.stringify({
        version,
        range: true,
        loader: live !== null && !live.settling,
        at: new Date().toISOString(),
        told: nextTold,
      }),
    )
  } catch {
    return null
  }
  return lines.length ? lines.join('\n') : null
}

/** The outcome the result itself reports, when it carries one. */
function applicationOf(result) {
  try {
    const value = typeof result?.value === 'string' ? JSON.parse(result.value) : result?.value
    const application = value && typeof value === 'object' ? value.application : undefined
    return typeof application === 'string' ? application : null
  } catch {
    return null
  }
}

function parseArgs(exec) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return null
  const install = args.action === 'install_bundle'
  const enable = args.action === 'set_bundle' && args.enabled === true
  if (!install && !enable) return null
  const target = typeof args.target === 'string' ? args.target.trim() : ''
  return target ? { target, enable } : null
}

/**
 * One call, one reminder, even when the call is a step inside a program: a
 * sub-call reports the program's root id, and that is the identity the check
 * was filed under. The target is only a fallback for callers that pass neither,
 * since two sessions installing the same spec would otherwise share one entry.
 */
function key(exec) {
  const root = exec?.rootCallId
  if (typeof root === 'string' && root) return root
  const dispatchId = exec?.['token'] ?? exec?.callId // ui-copy-ignore
  if (typeof dispatchId === 'string' && dispatchId) return dispatchId
  if (typeof dispatchId === 'symbol') return dispatchId
  const target = exec?.arguments?.target
  return typeof target === 'string' && target.trim() ? `target:${target.trim()}` : null
}

/** A reminder about a sub-call has to travel as context; content never reaches it. */
function asContext(texts) {
  // Shape the harness expects for a carried reminder: a plain user message.
  return texts.map((text) => ({
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'ptc-mode' },
  }))
}

/** Entries whose call never came back must not pile up. */
function sweep(now) {
  for (const [k, held] of pending) {
    if (now - held.at > TTL) pending.delete(k)
  }
}

/** Test seam: forget what has been reported so a fixture home can be checked. */
export function resetSkillWatch() {
  skillState.checkedAt = 0
  skillState.seen = null
  skillState.told.clear()
}

/** Notes arrive from separate checks; one check finding nothing must not hide another. */
function mergeNotes(...notes) {
  const kept = notes.filter(Boolean)
  if (!kept.length) return null
  return {
    zh: kept.map((note) => note.zh).join('\n'),
    en: kept.map((note) => note.en).join('\n'),
  }
}

/** Enabling moves a package already in the profile; the copy there is the candidate. */
function enabledCheck(call, profile, options) {
  const dir = join(profile, 'node_modules', call.target)
  if (!existsSync(join(dir, 'package.json'))) return null
  const candidate = scanPackage(dir)
  if (!candidate.isPlugin) return null
  const installed = installedPackages(profile)
  const result = compare(candidate, installed)
  const overlap = options.overlap === false ? [] : overlapFindings(candidate, installed)
  const risks = options.impl === false ? [] : implementationRisks(dir, { rules: Array.isArray(options.rules) ? options.rules : learnedRules() })
  const text = mergeNotes(result.ok ? null : render(candidate, result), renderOverlap(overlap), renderImplementation(risks))
  if (!text) return null
  return { candidate, result, overlap, text }
}

/** A registry target whose exact copy is already in the profile is read in place. */
function installedCopy(target, profile) {
  if (/^(link|file):/.test(target) || target.startsWith('.') || isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) return null
  const spec = /^((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(target)
  if (!spec) return null
  const dir = join(profile, 'node_modules', spec[1])
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!manifest?.version) return null
  const wanted = spec[2]
  if (!wanted || wanted === 'latest' || wanted === manifest.version) return dir
  return satisfies(manifest.version, wanted) === true ? dir : null
}

export async function checkInstall(exec, options = {}) {
  if (exec?.name !== 'plugin_manager') return null
  const call = parseArgs(exec)
  if (!call) return null
  const started = Date.now()
  const budget = options.budgetMs ?? 25_000

  const profile = options.profileDir ?? profileDir()
  if (call.enable) {
    try {
      return enabledCheck(call, profile, options)
    } catch {
      return null
    }
  }

  let dir = installedCopy(call.target, profile)
  let cleanup = async () => {}
  if (!dir) {
    try {
      const packed = await materialize(call.target, {
        timeoutMs: Math.min(options.timeoutMs ?? 20_000, Math.max(1_000, budget - (Date.now() - started))),
        signal: exec?.signal,
      })
      dir = packed.dir
      cleanup = packed.cleanup
    } catch (error) {
      // Running out of room is not a verdict: say the check did not finish.
      if (error instanceof Incomplete && error.reason !== 'missing-manifest') {
        return { incomplete: error.reason, text: renderIncomplete(error.reason) }
      }
      throw error
    }
  }

  try {
    if (Date.now() - started > budget) return { incomplete: 'slow', text: renderIncomplete('slow') }
    const candidate = scanPackage(dir)
    // plugin_manager rejects non-plugin specs on its own; don't add noise.
    if (!candidate.isPlugin) return null

    const installed = installedPackages(profile)
    const result = compare(candidate, installed)
    // Function-level overlap: same job, different names. Advisory, and off when
    // the profile asked for it.
    const overlap = options.overlap === false ? [] : overlapFindings(candidate, installed)
    // Same rule base as the preflight CLI, arriving at the install itself.
    const risks = options.impl === false ? [] : implementationRisks(dir, { rules: Array.isArray(options.rules) ? options.rules : learnedRules() })
    // No shared name, no missing dependency — and still able to eat the window.
    const takeover = scanPackageClient(dir)
    const version = shellVersion()
    const unmet = (version ? declaredRanges(dir) ?? [] : []).filter(({ range }) => !ALTERNATE.has(range))
    const miss = unmet.find(({ range }) => ['below', 'above'].includes(versionVerdict(version, range)))
    const range = miss?.range ?? null
    const verdict = range ? versionVerdict(version, range) : 'unknown'
    const zh = []
    const en = []
    if (!result.ok) {
      const note = render(candidate, result)
      zh.push(note.zh)
      en.push(note.en)
    }
    const close = renderOverlap(overlap)
    if (close) {
      zh.push(close.zh)
      en.push(close.en)
    }
    const deadly = renderImplementation(risks)
    if (deadly) {
      zh.push(deadly.zh)
      en.push(deadly.en)
    }
    if (verdict === 'below' || verdict === 'above') {
      const note = renderVersion(verdict, version, range)
      zh.push(note.zh)
      en.push(note.en)
    }
    if (takeover) {
      const risk = renderTakeover()
      zh.push(risk.zh)
      en.push(risk.en)
    }
    if (!zh.length) return null
    return { candidate, result, overlap, risks, text: { zh: zh.join('\n'), en: en.join('\n') } }
  } finally {
    await cleanup()
  }
}

export function apply(ctx, options = {}) {
  const disposers = []
  const listen = (event, fn) => {
    const off = ctx.on(event, fn)
    if (typeof off === 'function') disposers.push(off)
  }
  listen('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'plugin_manager') return next()
    try {
      const checked = await checkInstall(exec, { profileDir: profileDir(ctx), overlap: options.overlap, impl: options.impl })
      if (!checked) return next()
      const slot = key(exec)
      if (slot !== null) {
        sweep(Date.now())
        pending.set(slot, { checked, at: Date.now() })
      }
      return next()
    } catch {
      // A checker that cannot read the target must never touch the install.
      return next()
    }
  })

  listen('tools/post-execute', async (exec, result, next) => {
    const slot = key(exec)
    const held = slot === null ? undefined : pending.get(slot)
    if (slot !== null) pending.delete(slot)

    const decision = await next()
    if (result?.isError || decision?.kind !== 'accept') return decision

    // `failed` and `cancelled` changes already say what happened; adding our
    // notes would describe an install that did not take place.
    const application = applicationOf(result)
    if (application === 'failed' || application === 'cancelled') return decision
    // The profile changed under us; signatures read before the install described
    // the old files and must not be reused for the next check.
    scanCache.clear()

    const texts = []
    if (held) texts.push(held.checked.text.zh)
    const note = skillNote()
    if (note) texts.push(note)
    try {
      const audit = await versionAudit(ctx)
      if (audit) texts.push(audit)
    } catch {
      // A version note must never take down a tool result.
    }
    if (!texts.length) return decision

    // A program only sees the value its sub-call returns, so a note appended to
    // the content is written to a log nobody reads. Context is the channel that
    // reaches the model for those calls, and it survives a replaced value.
    if (exec?.parent !== undefined) {
      const carried = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
      return { ...decision, additionalContexts: [...carried, ...asContext(texts)] }
    }

    // Replacing the value rebuilds the content, so text cannot ride along.
    if (Object.hasOwn(decision, 'value')) return decision
    const base = Array.isArray(decision.content) ? decision.content : result?.content
    if (!Array.isArray(base)) return decision

    return {
      ...decision,
      content: [...base, ...texts.map((text) => ({ type: 'text', text }))],
    }
  })


  return () => {
    for (const off of disposers.splice(0)) {
      try {
        off()
      } catch {
        // Teardown must not throw.
      }
    }
  }
}
