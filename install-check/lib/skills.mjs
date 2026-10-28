/**
 * Skills are files, not packages, so nothing tells us when one arrives.
 * We read the two user-level roots the harness loads, note the fingerprint,
 * and only look again after it changes. Two skills cannot share a name:
 * the loader keeps one and the other is simply never offered. Two skills can
 * also spend the same words describing when to use them, which makes the
 * model pick the wrong one — that is worth a line, not a verdict.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILES = 200
const MAX_BYTES = 64 * 1024

/** Overlap this high means the two descriptions claim the same requests. */
const OVERLAP_RATIO = 0.6
const OVERLAP_SHARED = 6

const STOP = new Set(
  (
    'the a an and or of to for in on with use when user users this that these those it its is are be by as at from ' +
    'into not no all any your you they them their our we can should would could will may might also more most ' +
    'other others such than then there here only just like need needs needed want wants ask asks asked support ' +
    'supports using used does do when-to what how which who while before after within without'
  ).split(/\s+/),
)

/** The user-level roots the harness reads skills from. */
export function skillRoots(home = process.env.INSTALL_CHECK_HOME || homedir()) {
  return [join(home, '.dsh', 'skills'), join(home, '.agents', 'skills')]
}

function frontmatter(text) {
  if (!text.startsWith('---')) return text.slice(0, 4000)
  const end = text.indexOf('\n---', 3)
  return end === -1 ? text.slice(3, 4000) : text.slice(3, end)
}

/** A value may be a block scalar (`>` or `|`), and then the text lives below it. */
function field(block, names) {
  for (const name of names) {
    const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(block)
    if (!match) continue
    const inline = match[1].trim()
    if (inline && !/^[>|][+-]?$/.test(inline)) {
      return inline.replace(/^['"]|['"]$/g, '').trim()
    }
    const lines = []
    for (const line of block.slice(match.index + match[0].length).split('\n').slice(1)) {
      if (!line.trim()) {
        if (lines.length) lines.push('')
        continue
      }
      if (!/^\s+/.test(line)) break
      lines.push(line.trim())
    }
    return lines.join(' ').trim()
  }
  return ''
}

/** Chinese has no spaces, so two adjacent characters stand in for a word. */
const CJK_STOP = new Set('的了和与或是在时用要把它我你他她这那有个为以于就对不也都而及等'.split(''))

function words(text) {
  const lower = text.toLowerCase()
  const english = (lower.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []).filter((word) => !STOP.has(word))
  const cjk = []
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const pair = run.slice(i, i + 2)
      if (CJK_STOP.has(pair[0]) && CJK_STOP.has(pair[1])) continue
      cjk.push(pair)
    }
  }
  return new Set([...english, ...cjk])
}

/** Read every `<root>/<dir>/SKILL.md`; a skill's identity is its frontmatter name. */
export function scanSkills(roots) {
  const skills = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.slice(0, MAX_FILES)) {
      if (entry.name.startsWith('.')) continue
      // A skill directory is often a symlink into a dotfiles repo; the loader
      // follows it, so the scan has to as well.
      let directory = entry.isDirectory()
      if (!directory && entry.isSymbolicLink()) {
        try {
          directory = statSync(join(root, entry.name)).isDirectory()
        } catch {
          directory = false
        }
      }
      if (!directory) continue
      const file = join(root, entry.name, 'SKILL.md')
      let text = ''
      try {
        if (statSync(file).size > MAX_BYTES) continue
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const block = frontmatter(text)
      const name = field(block, ['name']) || entry.name
      const description = field(block, ['description'])
      const when = field(block, ['whenToUse', 'when_to_use', 'when-to-use'])
      skills.push({
        name,
        file,
        root,
        dir: entry.name,
        words: words(`${description} ${when}`),
      })
    }
  }
  return skills
}

/** Cheap "did anything arrive" check: names, sizes and mtimes of every skill file. */
export function fingerprint(roots) {
  const parts = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root).sort()
    } catch {
      continue
    }
    for (const name of entries.slice(0, MAX_FILES)) {
      try {
        const stat = statSync(join(root, name, 'SKILL.md'))
        parts.push(`${name}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      } catch {
        // a directory without SKILL.md is not a skill
      }
    }
  }
  return parts.join('|')
}

/**
 * `sandbox-next` and `sandbox-stable` are two versions of one thing, by design.
 * Only a trailing version-ish mark folds a name; folding at the first segment
 * would hide a real overlap between `ui-copy` and `ui-review`.
 */
const VARIANT = /^(?:next|stable|latest|beta|alpha|rc|v\d+|\d+)$/i

function family(name) {
  const parts = name.toLowerCase().split(/[-_.]/).filter(Boolean)
  while (parts.length > 1 && VARIANT.test(parts[parts.length - 1])) parts.pop()
  return parts.join('-')
}

/**
 * @param {object[]} skills from scanSkills()
 * @returns {{names: object[], overlaps: object[]}}
 */
export function findSkillConflicts(skills) {
  const byName = new Map()
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, [])
    byName.get(skill.name).push(skill)
  }
  const names = [...byName.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => ({ name, paths: owners.map((owner) => owner.file) }))

  const overlaps = []
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const a = skills[i]
      const b = skills[j]
      if (a.name === b.name) continue
      if (family(a.name) === family(b.name)) continue
      if (a.words.size < OVERLAP_SHARED || b.words.size < OVERLAP_SHARED) continue
      let shared = 0
      for (const word of a.words) if (b.words.has(word)) shared += 1
      const ratio = shared / Math.max(a.words.size, b.words.size)
      if (shared >= OVERLAP_SHARED && ratio >= OVERLAP_RATIO) {
        overlaps.push({ a: a.name, b: b.name, shared })
      }
    }
  }
  return { names, overlaps }
}
