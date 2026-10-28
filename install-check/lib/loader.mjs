/**
 * What the loader itself knows about plugins that never came up.
 *
 * The harness runs the same audit at boot and prints the failed entries, but
 * reading the live loader gives the answer at the moment it matters — the first
 * tool result after an update — and does not depend on a log file whose shape
 * is not ours.
 *
 * Two answers, because the fix differs: a fiber that never came up (import or
 * apply threw) waits for its own update; a fiber still waiting on a service is
 * usually missing a dependency, so the fix is to install the dependency.
 *
 * Fiber states are the numbers cordis assigns them: 0 pending, 1 loading,
 * 2 active, 3 failed, 4 disposed, 5 unloading. Only `active` counts as up;
 * loading and unloading are moves between states, so neither is evidence of a
 * break and both stay quiet until they settle.
 */

const ACTIVE = 2
const PENDING = 0
const LOADING = 1
const DISPOSED = 4
const UNLOADING = 5

/** Entry ids are load paths; the package name is what a person recognises. */
function label(entry) {
  const name = entry?.options?.name
  if (typeof name !== 'string' || !name) return null
  const parts = name.split('/')
  return parts[parts.length - 1]
}

function missingServices(fiber) {
  let keys
  try {
    keys = fiber?.inject && typeof fiber.inject === 'object' ? Object.keys(fiber.inject) : []
  } catch {
    return []
  }
  return keys.filter((service) => {
    try {
      return fiber.ctx?.get?.(service) === undefined
    } catch {
      return false
    }
  })
}

/**
 * A row only speaks for a plugin when its parent is running: a composition node
 * that never becomes an instance is a row, not a broken plugin.
 */
function parentRunning(entry) {
  try {
    const parent = entry?.parent
    if (!parent) return false
    const fiber = parent.ctx?.fiber
    return fiber != null && fiber.uid != null
  } catch {
    return false
  }
}

/** Whether a row is on now; a `disabled` expression that throws counts as off. */
function enabled(entry) {
  try {
    return !entry.disabled
  } catch {
    return null
  }
}

/**
 * Installed entries the loader has not brought up, split into those that broke,
 * those still waiting on a service, and whether anything is still moving.
 * Null when this build exposes no loader at all — then say nothing rather than
 * guess.
 */
export function inactive(ctx) {
  let entries
  try {
    entries = ctx?.loader?.entries?.()
    if (!entries) return null
    entries = [...entries]
  } catch {
    return null
  }

  const broken = new Set()
  const waiting = new Set()
  let settling = false
  for (const entry of entries) {
    try {
      const on = enabled(entry)
      if (on === true) {
        // fall through to the state checks
      } else if (on === false) continue
      else {
        // The row's own `disabled` expression threw: the loader counts that as
        // a failed entry, and so does this.
        const name = label(entry)
        if (name) broken.add(name)
        continue
      }

      const name = label(entry)
      if (!name) continue
      let fiber
      try {
        fiber = entry.fiber
      } catch {
        continue
      }
      // A row that never got a fiber is a failed import in the loader's own
      // audit; a disposed one is the wreck left behind by that failure.
      if (!fiber || fiber.state === DISPOSED) {
        if (parentRunning(entry)) broken.add(name)
        continue
      }
      if (typeof fiber.state !== 'number') continue
      if (fiber.state === ACTIVE) continue
      if (fiber.state === LOADING || fiber.state === UNLOADING) {
        settling = true
        continue
      }
      if (fiber.state === PENDING) {
        // A pending fiber with nothing missing is still coming up, not broken.
        if (missingServices(fiber).length) waiting.add(name)
        else settling = true
        continue
      }
      broken.add(name)
    } catch {
      // One odd entry must not hide the rest.
    }
  }
  return { broken: [...broken], waiting: [...waiting], settling }
}
