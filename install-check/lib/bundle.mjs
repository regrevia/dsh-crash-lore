// Reads a plugin's web client bundle for one specific habit: it looks up the
// shell's own containers by guessing at their class names, then pours its view
// into them, and it also carries a window-sized layer (fixed + inset 0 + a high
// z-index) for the case where the guess misses. When the shell's layout shifts,
// the guess misses every time and the window-sized layer is what you get: the
// sidebar and every button under it stop taking clicks, and only the plugin's
// own Escape can leave.
//
// A plugin that renders into a slot, or that floats its own click-through
// layer, does not match: no shell container is adopted, or no window-sized
// layer exists.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 2_000_000
const guessAdopt = /(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*document\.querySelector\(\s*['"`][^'"`]*\[(?:class\*|data-)/g
const windowLayer = [
  /position:\s*['"]?fixed/,
  /(?:inset:\s*0\b|inset:0\b|width:\s*['"]?100vw)/,
  /z-index:\s*\d{3,}/,
]

/** The file the shell boots for this plugin, if it ships a web client half. */
export function clientEntry(dir, manifest = {}) {
  const exported = manifest.exports?.['./client']
  if (typeof exported === 'string') return join(dir, exported)
  if (manifest.dsh?.client) {
    const entry = manifest.dsh.client.entry
    return join(dir, typeof entry === 'string' ? entry : 'client.js')
  }
  return null
}

/**
 * @returns {{ file: string, pane: string } | null} the container it takes over
 */
export function scanClient(dir, manifest) {
  const file = clientEntry(dir, manifest)
  if (!file) return null
  let source
  try {
    if (statSync(file).size > MAX_BYTES) return null
    source = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (!windowLayer.every((pattern) => pattern.test(source))) return null

  guessAdopt.lastIndex = 0
  let match
  while ((match = guessAdopt.exec(source))) {
    const pane = match[1]
    if (new RegExp(`\\b${pane}\\s*\\.appendChild\\(`).test(source)) return { file, pane }
  }
  return null
}

/** Same read, starting from an unpacked package directory. */
export function scanPackageClient(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  return scanClient(dir, manifest)
}
