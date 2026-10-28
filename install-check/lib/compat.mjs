/**
 * Does the running harness fall inside the range a plugin declares?
 *
 * Answers true / false / null; null means "the range was not understood" and the
 * caller must stay silent. Prerelease builds count as ordinary versions, which
 * is also how the harness evaluates ranges.
 */
const FULL = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PART = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text) {
  const match = FULL.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] }
}

function preCompare(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right)
      if (diff) return diff < 0 ? -1 : 1
    } else if (leftNum) return -1
    else if (rightNum) return 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return preCompare(left.pre, right.pre)
}

/** A possibly partial version: a wildcard or missing part is null. */
function partial(spec) {
  const match = PART.exec(String(spec ?? '').trim())
  if (!match) return null
  const num = (part) => (part === undefined || /^[xX*]$/.test(part) ? null : Number(part))
  return { major: num(match[1]), minor: num(match[2]), patch: num(match[3]), pre: match[4] ? match[4].split('.') : [] }
}

function at(version, major, minor, patch) {
  return { major, minor, patch, pre: version.pre }
}

/** The lowest version a partial names: `1.2` is `1.2.0`. */
function floorOf(version) {
  return at(version, version.major ?? 0, version.minor ?? 0, version.patch ?? 0)
}

const gte = (version) => ({ op: '>=', version })
const lt = (version) => ({ op: '<', version })

/** Comparators for `^`, `~` and bare partials. null when the shape is unknown. */
function expand(version, operator) {
  const { major, minor, patch, pre } = version
  if (major === null) return []
  if (operator === '^') {
    if (minor === null) return [gte(at(version, major, 0, 0)), lt(at(version, major + 1, 0, 0))]
    if (patch === null) {
      return major === 0
        ? [gte(at(version, 0, minor, 0)), lt(at(version, 0, minor + 1, 0))]
        : [gte(at(version, major, minor, 0)), lt(at(version, major + 1, 0, 0))]
    }
    const high = major > 0 ? at(version, major + 1, 0, 0) : minor > 0 ? at(version, 0, minor + 1, 0) : at(version, 0, 0, patch + 1)
    return [gte(at(version, major, minor, patch)), lt(high)]
  }
  if (operator === '~') {
    if (minor === null) return [gte(at(version, major, 0, 0)), lt(at(version, major + 1, 0, 0))]
    return [gte(at(version, major, minor, patch ?? 0)), lt(at(version, major, minor + 1, 0))]
  }
  // Bare or `=` partial: 1 -> 1.x, 1.2 -> 1.2.x, 1.2.3 -> exactly.
  if (minor === null) return [gte(at(version, major, 0, 0)), lt(at(version, major + 1, 0, 0))]
  if (patch === null) return [gte(at(version, major, minor, 0)), lt(at(version, major, minor + 1, 0))]
  return [{ op: '=', version: at(version, major, minor, patch) }]
}

/** One space-separated piece; null when it cannot be read. */
function comparators(piece) {
  if (piece === '' || piece === '*' || piece === 'x' || piece === 'X') return []
  const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(piece)
  if (!match) return null
  const operator = match[1] ?? ''
  const version = partial(match[2])
  if (!version) return null
  if (operator === '' || operator === '=' || operator === '^' || operator === '~') return expand(version, operator)
  if (version.major === null) return []
  const low = floorOf(version)
  if (operator === '>') {
    // `>1.2` means at least the next minor, since 1.2.x is excluded.
    if (version.minor === null) return [gte(at(version, version.major + 1, 0, 0))]
    if (version.patch === null) return [gte(at(version, version.major, version.minor + 1, 0))]
    return [{ op: '>', version: low }]
  }
  if (operator === '<=') {
    // A partial ceiling excludes the whole range it names: `<=1` is `<2.0.0`,
    // `<=1.2` is `<1.3.0`, and only a full version is an inclusive ceiling.
    if (version.minor === null) return [{ op: '<', version: at(version, version.major + 1, 0, 0) }]
    if (version.patch === null) return [{ op: '<', version: at(version, version.major, version.minor + 1, 0) }]
    return [{ op: '<=', version: low }]
  }
  if (operator === '<') return [{ op: '<', version: low }]
  return [gte(low)]
}

/** `a - b`, with `b` as a partial ceiling. */
function hyphen(low, high) {
  const from = partial(low)
  const to = partial(high)
  if (!from || !to || from.major === null || to.major === null) return null
  const parts = [gte(floorOf(from))]
  if (to.patch !== null) parts.push({ op: '<=', version: floorOf(to) })
  else if (to.minor !== null) parts.push(lt(at(to, to.major, to.minor + 1, 0)))
  else parts.push(lt(at(to, to.major + 1, 0, 0)))
  return parts
}

/**
 * Prereleases are compared, not excluded: this harness ships prerelease builds,
 * so a range has to admit them the way the loader does.
 */
function passes(version, list) {
  for (const item of list) {
    const order = compareVersions(version, item.version)
    if (order === null) return null
    const ok = item.op === '=' ? order === 0 : item.op === '>=' ? order >= 0 : item.op === '<=' ? order <= 0 : item.op === '>' ? order > 0 : order < 0
    if (!ok) return false
  }
  return true
}

/** true / false / null; `false` only when every alternative was understood. */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (!parsed || typeof range !== 'string' || !range.trim()) return null
  let sawUnknown = false
  for (const alternative of range.split('||')) {
    const text = alternative.trim().replace(/\s+/g, ' ')
    if (!text) continue
    let list = null
    if (text === '') list = []
    else {
      const span = /^(\S+)\s+-\s+(\S+)$/.exec(text)
      if (span) list = hyphen(span[1], span[2])
      else {
        list = []
        for (const piece of text.split(' ')) {
          const part = comparators(piece)
          if (part === null) {
            list = null
            break
          }
          list.push(...part)
        }
      }
    }
    if (list === null) {
      sawUnknown = true
      continue
    }
    const verdict = passes(parsed, list)
    if (verdict === true) return true
    if (verdict === null) sawUnknown = true
  }
  return sawUnknown ? null : false
}

/** The lowest version a range mentions, or null. */
function lowest(range) {
  let min = null
  for (const piece of String(range).split(/[\s|]+/)) {
    const match = /^(>=|>|=|\^|~)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(piece)
    if (!match) continue
    const version = parseVersion(`${match[2]}.${match[3] ?? '0'}.${/^[xX*]$/.test(match[4] ?? '0') ? '0' : match[4] ?? '0'}`)
    if (!version) continue
    if (!min || compareVersions(version, min) < 0) min = version
  }
  return min
}

/**
 * 'ok' | 'below' | 'above' | 'unknown'. `below` means the plugin wants a newer
 * harness than this one; `above` means it declared a ceiling this one passed.
 */
export function versionVerdict(version, range) {
  const verdict = satisfies(version, range)
  if (verdict !== false) return verdict === null ? 'unknown' : 'ok'
  const min = lowest(range)
  return min && compareVersions(version, min) < 0 ? 'below' : 'above'
}
