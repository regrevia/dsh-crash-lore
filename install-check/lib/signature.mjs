/**
 * Reads a plugin package the way the Loader will see it: which tools it
 * registers, which services it provides, which routes and slots it claims.
 *
 * Static only. Nothing is imported or executed.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', 'docs', 'examples', 'coverage'])
const MAX_FILES = 80
const MAX_BYTES = 512 * 1024

const SCHEMA_WORDS = new Set([
  'type', 'description', 'properties', 'required', 'schema', 'parameters', 'items',
  'enum', 'default', 'title', 'additionalproperties', 'oneof', 'anyof', 'const',
])

const PLAIN = /^[a-z][a-z0-9_]{1,48}$/

function listJsFiles(dir, out = [], depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listJsFiles(path, out, depth + 1)
    } else if (JS_EXT.has(extname(entry.name))) {
      out.push(path)
    }
  }
  return out
}

function readText(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
  } catch {
    return ''
  }
}

function collect(text, pattern, group = 1) {
  const out = []
  for (const match of text.matchAll(pattern)) {
    const value = match[group]
    if (value) out.push(value)
  }
  return out
}

function quoted(text) {
  return collect(text, /['"]([^'"\n]+)['"]/g)
}

/**
 * A small scanner instead of a regex: comments and string bodies never become
 * code, so a `name:` in a comment or a data table stops being a claim. Tokens
 * keep their source order; on top of them the only question asked is "which
 * object literal is an argument of which registration call".
 */
function tokenize(text) {
  const out = []
  const len = text.length
  let index = 0
  let last = null
  const isStart = (char) => /[A-Za-z_$]/.test(char)
  const isPart = (char) => /[A-Za-z0-9_$]/.test(char)
  // A slash after one of these starts a regex; after a value it is division.
  const division = last === 'id' || last === 'num' || last === 'str' || last === ')' || last === ']'
  while (index < len) {
    const char = text[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? len : end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? len : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1
      let value = ''
      let plain = true
      while (cursor < len) {
        const inner = text[cursor]
        if (inner === '\\') {
          value += text.slice(cursor + 1, cursor + 2)
          cursor += 2
          continue
        }
        if (inner === char) break
        if (char !== '`' && inner === '\n') break
        if (char === '`' && inner === '$' && text[cursor + 1] === '{') plain = false
        value += inner
        cursor += 1
      }
      out.push({ kind: 'str', value: plain ? value : '', index })
      last = 'str'
      index = cursor + 1
      continue
    }
    if (isStart(char)) {
      let cursor = index + 1
      while (cursor < len && isPart(text[cursor])) cursor += 1
      out.push({ kind: 'id', value: text.slice(index, cursor), index })
      last = 'id'
      index = cursor
      continue
    }
    if (/[0-9]/.test(char)) {
      let cursor = index + 1
      while (cursor < len && /[0-9.a-zA-Z_]/.test(text[cursor])) cursor += 1
      out.push({ kind: 'num', value: text.slice(index, cursor), index })
      last = 'num'
      index = cursor
      continue
    }
    if (char === '/' && !division) {
      let cursor = index + 1
      let inClass = false
      while (cursor < len) {
        const inner = text[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === '\n') break
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        cursor += 1
      }
      cursor += 1
      while (cursor < len && /[a-z]/i.test(text[cursor])) cursor += 1
      out.push({ kind: 'regex', value: '', index })
      last = 'regex'
      index = cursor
      continue
    }
    out.push({ kind: 'punc', value: char, index })
    last = char
    index += 1
  }
  return out
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function closeOf(tokens, open) {
  let depth = 0
  for (let index = open; index < tokens.length; index += 1) {
    const value = tokens[index].kind === 'punc' ? tokens[index].value : ''
    if (value === '(') depth += 1
    else if (value === ')') {
      depth -= 1
      if (!depth) return index
    }
  }
  return -1
}

/**
 * The literal properties of the object literal that is the call's first
 * argument. Only top-level `key: 'literal'` pairs; spread, computed keys and
 * nested objects are invisible, so they make no claim.
 */
function literalProps(tokens, open, close) {
  const props = new Map()
  if (tokens[open + 1]?.value !== '{') return props
  let depth = 0
  for (let index = open + 2; index < close; index += 1) {
    const part = tokens[index]
    const value = part.kind === 'punc' ? part.value : ''
    if (value === '{' || value === '[' || value === '(') depth += 1
    else if (value === '}' || value === ']' || value === ')') depth -= 1
    else if (!depth && part.kind === 'id' && tokens[index + 1]?.value === ':' && tokens[index + 2]?.kind === 'str') {
      if (!props.has(part.value)) props.set(part.value, tokens[index + 2].value)
    }
  }
  return props
}

/** Which method is this `(` the argument list of, and on what chain. */
function callName(tokens, open) {
  const name = tokens[open - 1]
  if (name?.kind !== 'id') return null
  const chain = []
  let index = open - 2
  while (index >= 1 && tokens[index].value === '.') {
    const id = tokens[index - 1]
    if (id?.kind !== 'id') break
    chain.unshift(id.value)
    index -= 2
  }
  return { name: name.value, receiver: chain.at(-1) ?? '', chain }
}

/**
 * Tool names with the layer they land in, as far as source can tell: a
 * registration reached through an agent context is a per-agent variant, which
 * shadows a global one instead of colliding with it.
 */
function toolCalls(tokens) {
  const found = []
  const spans = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'punc' || tokens[index].value !== '(') continue
    const call = callName(tokens, index)
    if (!call) continue
    const register = (call.name === 'register' || call.name === 'registerTool') && /^tools?$/i.test(call.receiver)
    if (!register && call.name !== 'defineTool') continue
    const close = closeOf(tokens, index)
    if (close === -1) continue
    const scoped = call.chain.some((id) => /agent/i.test(id))
    if (register) spans.push({ from: index, to: close, scoped })
    const name = literalProps(tokens, index, close).get('name')
    if (name) found.push({ name, at: index })
  }
  return found.map((entry) => ({
    name: entry.name,
    scoped: spans.some((span) => span.from < entry.at && entry.at < span.to && span.scoped),
  }))
}

function routeCalls(tokens) {
  const out = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'punc' || tokens[index].value !== '(') continue
    const call = callName(tokens, index)
    if (!call) continue
    if (call.name === 'registerFallback') {
      out.push('fallback')
      continue
    }
    if (!/web|server/i.test(call.receiver)) continue
    if (call.name !== 'register' && call.name !== 'registerRoute' && call.name !== 'registerUpgrade') continue
    const close = closeOf(tokens, index)
    if (close === -1) continue
    const props = literalProps(tokens, index, close)
    const path = props.get('path')
    if (!path || !path.startsWith('/')) continue
    if (call.name === 'registerUpgrade') {
      out.push('upgrade:' + path)
      continue
    }
    const kind = props.get('kind')
    if (kind === 'exact' || kind === 'prefix') out.push(kind + ':' + path)
  }
  return out
}

/**
 * Tool names, read from the registration call's own object literal. A `name:`
 * on an unrelated object, in a comment, or in a plain data file is not a tool.
 */
function extractTools(text) {
  if (!/defineTool|registerTool|\bregister\b/.test(text)) return []
  return toolCalls(tokenize(text)).filter((entry) => PLAIN.test(entry.name) && !SCHEMA_WORDS.has(entry.name))
}

/**
 * Services: `.provide('key')` / `ctx.set('key', ...)`, plus lazy reads the
 * plugin performs itself (`ctx.get('key')`), which are soft dependencies.
 */
function extractServices(text) {
  return [
    ...collect(text, /\.provide\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g),
    ...collect(text, /\bctx\.set\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g),
  ]
}

function extractLazyGets(text) {
  return collect(text, /\bctx\.get\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g)
}

/**
 * Routes the web server keys by (kind, path) and rejects duplicates outright,
 * so both halves of the key have to be read. Only literals are visible here:
 * a path held in a constant is not a claim this check can make.
 */
function extractRoutes(text) {
  if (!/register/.test(text)) return []
  return routeCalls(tokenize(text))
}

function extractSlots(text) {
  return collect(text, /slots\.(?:register|inject)\s*\(\s*['"]([\w.:-]+)['"]/g)
}

function extractPatchIds(patchText) {
  return [
    ...collect(patchText, /^\s*-\s*id:\s*['"]?([\w@/.:-]+)['"]?\s*$/gm),
    ...collect(patchText, /^\s+id:\s*['"]?([\w@/.:-]+)['"]?\s*$/gm),
  ]
}

/**
 * Rows a patch adds versus rows it only edits. A patch that names an existing
 * id without `insert` overrides that row, so it is not claiming the row.
 */
function patchClaims(patchText) {
  const inserts = new Set()
  const overrides = new Set()
  let insertIndent = null
  for (const line of patchText.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.replace(/^\s+/, '').length
    const trimmed = line.trim()
    if (insertIndent !== null && indent <= insertIndent) insertIndent = null
    if (/^-?\s*insert:\s*$/.test(trimmed)) {
      insertIndent = indent
      continue
    }
    const id = /^-?\s*id:\s*['"]?([\w@/.:-]+)['"]?\s*$/.exec(trimmed)
    if (!id) continue
    if (insertIndent !== null && indent > insertIndent) inserts.add(id[1])
    else overrides.add(id[1])
  }
  return { inserts: [...inserts], overrides: [...overrides] }
}

function extractPatchNames(patchText) {
  return collect(patchText, /^\s*-?\s*name:\s*['"]?(@?[\w@/.:-]+)['"]?\s*$/gm)
}

function patchRowCount(patchText) {
  return extractPatchIds(patchText).length
}

/**
 * @param {string} dir package directory
 * @returns {object} signature used for collision checks
 */
export function scanPackage(dir) {
  const manifestPath = join(dir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    manifest = null
  }

  const files = listJsFiles(dir)
  const texts = files.map((file) => ({ file, text: readText(file) }))

  const tools = new Set()
  const scopedTools = new Set()
  const services = new Set()
  const lazyGets = new Set()
  const routes = new Set()
  const slots = new Set()

  for (const { text } of texts) {
    for (const entry of extractTools(text)) {
      tools.add(entry.name)
      if (entry.scoped) scopedTools.add(entry.name)
    }
    for (const name of extractServices(text)) services.add(name)
    for (const name of extractLazyGets(text)) lazyGets.add(name)
    for (const route of extractRoutes(text)) routes.add(route)
    for (const slot of extractSlots(text)) slots.add(slot)
  }

  let patchIds = []
  let patchNames = []
  let patchInserts = []
  let patchOverrides = []
  const patchPath = manifest?.dsh?.bundle?.patch
  if (patchPath && existsSync(join(dir, patchPath))) {
    const patchText = readText(join(dir, patchPath))
    const claims = patchClaims(patchText)
    patchIds = [...new Set(extractPatchIds(patchText))]
    patchNames = [...new Set(extractPatchNames(patchText))]
    patchInserts = claims.inserts
    patchOverrides = claims.overrides
  }

  return {
    name: manifest?.name ?? dir,
    version: manifest?.version ?? '',
    dir,
    manifest,
    isPlugin: Boolean(manifest?.dsh?.bundle || manifest?.dsh?.client || patchIds.length),
    tools: [...tools], // ui-copy-ignore
    scopedTools: [...scopedTools], // ui-copy-ignore
    services: [...services], // ui-copy-ignore
    lazyGets: [...lazyGets], // ui-copy-ignore
    routes: [...routes], // ui-copy-ignore
    slots: [...slots], // ui-copy-ignore
    patchIds,
    patchInserts, // ui-copy-ignore
    patchOverrides, // ui-copy-ignore
    patchNames,
    peerDeps: manifest?.peerDependencies ?? {},
    clientInject: manifest?.dsh?.client?.inject ?? [],
    filesScanned: files.length,
    truncated: files.length >= MAX_FILES,
    patchRows: patchRowCount(manifest?.dsh?.bundle?.patch ? readText(join(dir, manifest.dsh.bundle.patch)) : ''),
  }
}

export { listJsFiles }
