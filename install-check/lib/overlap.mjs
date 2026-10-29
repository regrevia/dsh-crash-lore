/**
 * Function-level overlap between the package being installed and what is already
 * there. `check.mjs` answers "will they collide" (same tool name, same service,
 * same row). This answers the softer question the user actually asks before
 * installing: "am I about to run two plugins that do the same job?"
 *
 * Two plugins doing the same job rarely throw. They fight: both react to the same
 * input, both write the same kind of state, both put a control in the same slot,
 * and when something does go wrong the log points at two candidates. That is the
 * case this reports on.
 *
 * Advisory only: nothing here blocks an install, and every finding is a guess
 * that must be cheap to ignore. Data comes from signatures already scanned by
 * `scanPackage`, so this module reads no files.
 */

/** Words that say how a tool works, not what it is for. */
const generic = new Set([
  'tool', 'tools', 'list', 'open', 'close', 'read', 'write', 'save', 'load', 'get', 'set',
  'run', 'send', 'call', 'show', 'hide', 'start', 'stop', 'create', 'delete', 'update',
  'query', 'fetch', 'init', 'apply', 'check', 'with', 'from', 'into', 'this', 'that',
  'name', 'data', 'info', 'item', 'items', 'file', 'files', 'page', 'pages', 'value',
])

/** Split `inner_browser_open`, `browserOpen` and `browser.open` the same way. */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 4 && !generic.has(word))
}

/** Capability words a package claims through the tools it registers. */
export function capabilityWords(signature) {
  const found = new Set()
  for (const tool of signature?.tools ?? []) {
    for (const word of words(tool)) found.add(word)
  }
  return [...found]
}

function shared(a, b) {
  const right = new Set(b)
  return a.filter((word) => right.has(word))
}

function slotText(slot, other, locale) {
  if (locale === 'zh') {
    return `和 ${other} 都往 ${slot} 里放东西，界面上会叠成两份、互相覆盖；只留一个，或先关掉其中一个再装。`
  }
  return `Both put something in ${slot}; the two will stack and overwrite each other. Keep one, or turn one off before installing.`
}

function nearText(tokens, other, locale) {
  const list = tokens.join(locale === 'zh' ? '、' : ', ')
  if (locale === 'zh') {
    return `和 ${other} 功能重叠：都用 ${list} 这一类能力。两套同时开容易抢同一份输入输出，效果变差，真出问题也分不清是谁；装之前先决定要不要留一个。`
  }
  return `Overlaps with ${other}: both provide ${list}-style capability. Running both means they compete for the same input and output — worse results, and no clear culprit when something breaks. Decide before installing whether you want both.`
}

/**
 * @param {object} candidate signature of the package being installed
 * @param {object[]} installed signatures already in the profile
 * @returns {Array<{kind: string, other: string, shared: string[], zh: string, en: string}>}
 */
export function overlapFindings(candidate, installed) {
  if (!candidate?.isPlugin) return []
  const mine = capabilityWords(candidate)
  const mySlots = candidate.slots ?? []
  const findings = []

  for (const other of installed ?? []) {
    if (!other?.isPlugin || other.name === candidate.name) continue

    const sameSlots = mySlots.filter((slot) => (other.slots ?? []).includes(slot))
    for (const slot of sameSlots.slice(0, 2)) {
      findings.push({
        kind: 'slot',
        other: other.name,
        shared: [slot],
        zh: slotText(slot, other.name, 'zh'),
        en: slotText(slot, other.name, 'en'),
      })
    }

    const tokens = shared(mine, capabilityWords(other))
    if (tokens.length) {
      findings.push({
        kind: 'capability',
        other: other.name,
        shared: tokens,
        zh: nearText(tokens, other.name, 'zh'),
        en: nearText(tokens, other.name, 'en'),
      })
    }
  }

  // A shared UI slot is the louder signal; capability overlap explains more.
  const rank = (finding) => (finding.kind === 'slot' ? 0 : 1)
  findings.sort((a, b) => rank(a) - rank(b) || b.shared.length - a.shared.length)
  return findings.slice(0, 3)
}

/** @returns {{zh: string, en: string}|null} */
export function renderOverlap(findings) {
  if (!findings?.length) return null
  return {
    zh: findings.map((finding) => finding.zh).join('\n'),
    en: findings.map((finding) => finding.en).join('\n'),
  }
}
