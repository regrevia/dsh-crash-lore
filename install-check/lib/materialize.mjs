/**
 * Turns an install target into a directory we can read.
 *
 * Local paths are used in place. Registry specs are packed into a temp folder
 * with npm and unpacked there; nothing is installed into the profile.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, isAbsolute, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * The check ran out of room before it could answer: no npm, no network, a target
 * that is not a package. This is not a verdict about the plugin, and the caller
 * says so instead of staying silent.
 */
export class Incomplete extends Error {
  constructor(reason, cause) {
    super(reason, { cause })
    this.name = 'Incomplete'
    this.reason = reason
  }
}

function run(command, args, options) {
  return execFileAsync(command, args, { maxBuffer: MAX_BUFFER, ...options })
}

/**
 * npm is a `.cmd` shim on Windows and cannot be spawned without a shell, so use
 * the CLI script next to this Node when it is there; that works on every
 * platform and never depends on PATH.
 */
function npmCommand() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { command: process.execPath, args: [cli], shell: false }
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm'], shell: true }
  }
  return { command: 'npm', args: [], shell: false }
}

/** A target that names a folder: POSIX, drive letter, UNC, or a home shorthand. */
function localPath(target) {
  const plain = target.replace(/^(link|file):/, '')
  const looksLocal =
    plain.startsWith('/') ||
    plain.startsWith('./') ||
    plain.startsWith('../') ||
    plain.startsWith('~/') ||
    plain.startsWith('.\\') ||
    plain.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(plain) ||
    plain.startsWith('\\\\')
  if (!looksLocal) return null
  let expanded = plain
  if (plain.startsWith('~/') || plain.startsWith('~\\')) expanded = join(homedir(), plain.slice(2))
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** A failed npm run knows whether it was the network, the registry, or the tarball. */
function classify(error) {
  const text = `${error?.stderr ?? ''} ${error?.stdout ?? ''} ${error?.message ?? ''}`
  if (error?.killed || /timed? ?out|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET/.test(text)) return 'network'
  if (/no matching version|notarget|E404|not in this registry/i.test(text)) return 'not-found'
  if (/EJSONPARSE|invalid JSON|Invalid package/i.test(text)) return 'unreadable'
  return 'unknown'
}

/**
 * @param {string} target install target: path, name, name@range, or link:/file: spec
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>, local: boolean}>}
 */
export async function materialize(target, options = {}) {
  const { timeoutMs = 25000, signal } = options
  const path = localPath(target)
  if (path) {
    if (!existsSync(join(path, 'package.json'))) throw new Incomplete('missing-manifest')
    return { dir: path, local: true, cleanup: async () => {} }
  }

  const work = await mkdtemp(join(tmpdir(), 'dsh-install-check-'))
  const cleanup = async () => {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
  const npm = npmCommand()
  const args = [...npm.args, 'pack', target, '--pack-destination', work, '--json', '--no-audit', '--no-fund', '--ignore-scripts']

  try {
    const settings = { cwd: work, timeout: timeoutMs, signal, shell: npm.shell }
    const { stdout } = await run(npm.command, args, settings)
    const packed = JSON.parse(stdout)[0]
    if (!packed?.filename) throw new Incomplete('not-found')
    await run('tar', ['-xzf', join(work, packed.filename), '-C', work], { timeout: timeoutMs, signal })
    const entries = await readdir(work)
    const dir = entries.includes('package') ? join(work, 'package') : work
    return { dir, local: false, cleanup }
  } catch (error) {
    await cleanup()
    if (error instanceof Incomplete) throw error
    throw new Incomplete(classify(error), error)
  }
}
