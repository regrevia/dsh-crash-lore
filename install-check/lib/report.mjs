/**
 * Verdict first, then the reason, then the one action. Two or three lines,
 * no mechanism talk ("the model only sees one"), no scores, no categories.
 */

const MAX_NAMES = 3

function list(items, locale) {
  const shown = items.slice(0, MAX_NAMES)
  const rest = items.length - shown.length
  const joiner = locale === 'zh' ? '、' : ', '
  const tail = rest > 0 ? (locale === 'zh' ? ` 等 ${items.length} 个` : ` and ${rest} more`) : ''
  return `${shown.join(joiner)}${tail}`
}

function unique(items) {
  return [...new Set(items)]
}

function keysOf(result, kind) {
  return unique(result.breaks.filter((finding) => finding.kind === kind).map((finding) => finding.key))
}

/**
 * A plugin that owns the content pane by guessing at the shell's DOM is one
 * layout change away from covering the whole window, where nothing clicks.
 */
export function renderTakeover() {
  return {
    zh: '风险：它接管整块内容区，界面一变就铺满全屏，按钮点不到。\n装完按 Esc，关不掉就在插件页停用它。',
    en: 'Risk: it takes over the content area; when the shell changes it covers the window and clicks stop landing.\nPress Esc after install, disable it in plugins if it stays.',
  }
}

/**
 * The plugin's own declared version range, against what is running. Shown only
 * when the range was understood and excludes this version.
 */
export function renderVersion(verdict, version, range) {
  if (verdict === 'below') {
    return {
      zh: `版本对不上：它要 ${range}，这台是 ${version}。\n装上起不来，先升级再装。`,
      en: `Version mismatch: it needs ${range}, this is ${version}.\nIt will not start; update first.`,
    }
  }
  return {
    zh: `版本对不上：它只支持 ${range}，这台是 ${version}。\n装上可能起不来，先更新插件。`,
    en: `Version mismatch: it supports ${range}, this is ${version}.\nIt may not start; update the plugin first.`,
  }
}

/** After an update: plugins the running loader never brought up (import or apply threw). */
export function renderBroken(names) {
  return {
    zh: `升级后起不来：${list(names, 'zh')}。先更新，或停用。`,
    en: `Broken by the update: ${list(names, 'en')}. Update or disable them.`,
  }
}

/**
 * After an update: plugins waiting on something this build no longer provides.
 * Usually a dependency that is gone or switched off, so the fix is the dependency.
 */
export function renderUnconnected(names) {
  return {
    zh: `升级后没接上：${list(names, 'zh')} 要的依赖不在了。先装上依赖，或停用它。`,
    en: `Left unconnected by the update: ${list(names, 'en')} need something this build no longer provides.\nInstall the dependency or disable them.`,
  }
}

/** After a harness update: the installed plugins whose ranges the new version left. */
export function renderVersionAudit(names, version) {
  const shown = list(names, 'zh')
  return {
    zh: `版本对不上：${shown} 在 ${version} 上起不来。先更新，或停用。`,
    en: `Version mismatch: ${list(names, 'en')} will not start on ${version}. Update or disable them.`,
  }
}

/** The reason, in plain nouns: same tool name, same service, same slot in the list. */
function because(result, locale) {
  const parts = []
  const tools = keysOf(result, 'tool')
  const services = keysOf(result, 'service')
  if (tools.length) {
    parts.push(locale === 'zh' ? `用同一个工具名 ${list(tools, locale)}` : `uses the same tool name ${list(tools, locale)}`)
  }
  if (services.length) {
    parts.push(locale === 'zh' ? `用同一个服务 ${list(services, locale)}` : `provides the same service ${list(services, locale)}`)
  }
  if (keysOf(result, 'row').length) {
    parts.push(locale === 'zh' ? '装在同一个位置' : 'installs in the same row')
  }
  const routes = keysOf(result, 'route')
  if (routes.length) {
    const paths = routes.map((key) => key.slice(key.indexOf(':') + 1))
    parts.push(locale === 'zh' ? `抢同一个地址 ${list(paths, locale)}` : `claims the same address ${list(paths, locale)}`)
  }
  if (keysOf(result, 'fallback').length) {
    parts.push(locale === 'zh' ? '都接管所有未匹配的请求' : 'both take every unmatched request')
  }
  return parts.join(locale === 'zh' ? '，' : ', ')
}

function owners(result) {
  return unique(result.breaks.flatMap((finding) => finding.owners ?? []))
}

/**
 * @param {object} candidate scanned candidate
 * @param {{findings: object[], breaks: object[], missing: object[]}} result
 */
export function render(candidate, result) {
  const zh = []
  const en = []

  if (result.breaks.length) {
    const who = list(owners(result), 'zh')
    const whoEn = list(owners(result), 'en')
    // A tool name is not a seat: two registrations in one layer fail the later
    // plugin, while a per-agent variant is allowed to shadow a global one. Say
    // which case this is, and only claim the failure when both sides are global.
    const shadowed = result.breaks.every((finding) => finding.kind === 'tool')
    if (shadowed) {
      const tools = list(keysOf(result, 'tool'), 'zh')
      const toolsEn = list(keysOf(result, 'tool'), 'en')
      const certain = result.breaks.every((finding) => finding.certain !== false)
      if (certain) {
        zh.push(`同名工具：和 ${who} 都用 ${tools}，后装的那个起不来。`)
        zh.push(`两个都要用，先让其中一个改名。`)
        en.push(`Same tool name as ${whoEn}: ${toolsEn}. The later one cannot load.`)
        en.push(`To keep both tools, rename one of them.`)
      } else {
        zh.push(`同名工具：和 ${who} 都注册了 ${tools}，可能有一个起不来。`)
        zh.push(`装完看有没有报同名工具注册失败；两个都要用就先改名。`)
        en.push(`Same tool name as ${whoEn}: ${toolsEn}. One of them may fail to load.`)
        en.push(`Check for a duplicate-name failure after install; rename one if both are wanted.`)
      }
    } else {
      zh.push(`冲突：和 ${who} ${because(result, 'zh')}，两个只能留一个。`)
      zh.push(`两个都想要，先停用 ${who} 再重启。`)
      en.push(`Conflict: it ${because(result, 'en')} as ${whoEn}; only one can be live.`)
      en.push(`To keep both, disable ${whoEn} and restart.`)
    }
  }

  if (result.missing.length) {
    const names = list(result.missing.map((finding) => finding.key), 'zh')
    zh.push(`缺 ${names}，装上它之前这个插件起不来。`)
    en.push(`Missing ${names}; the plugin cannot start until it is installed.`)
  }

  return { zh: zh.join('\n'), en: en.join('\n') }
}

/**
 * Skills: a shared name costs you a skill, a shared description costs you the
 * right pick. Both are worth one line each, with the fix in the same line.
 */
export function renderSkills(conflicts) {
  const zh = []
  const en = []
  for (const hit of conflicts.names.slice(0, 1)) {
    zh.push(`冲突：两个 skill 都叫 ${hit.name}，只会生效一个。留一个，或给其中一个改名。`)
    en.push(`Conflict: two skills are both named ${hit.name}; only one loads. Keep one, or rename the other.`)
  }
  for (const hit of conflicts.overlaps.slice(0, 2)) {
    zh.push(`两个 skill 的描述相似：${hit.a} 和 ${hit.b}，建议检查触发边界。`)
    en.push(`Two skills describe similar triggers: ${hit.a} and ${hit.b}. Check where each one is meant to start.`)
  }
  return { zh: zh.join('\n'), en: en.join('\n') }
}

export function summary(candidate, result) {
  if (result.ok) return `${candidate.name}：没撞上已装的插件。`
  if (result.breaks.length) return `${candidate.name}：和已装插件冲突，只能留一个。`
  return `${candidate.name}：还缺依赖。`
}

/**
 * The check never reached a verdict: the package could not be read in time.
 * Say so plainly — a silent checker looks like a clean bill of health.
 */
export function renderIncomplete(reason) {
  if (reason === 'not-found') {
    return {
      zh: '没检查完：这个包没找到，装完看一眼有没有报错。',
      en: 'Check unfinished: the package was not found. Look at the result after installing.',
    }
  }
  if (reason === 'network') {
    return {
      zh: '没检查完：包没下载下来，装完看一眼有没有报错。',
      en: 'Check unfinished: the package did not download. Look at the result after installing.',
    }
  }
  if (reason === 'slow') {
    return {
      zh: '没检查完：读这个包花的时间太长，装完看一眼有没有报错。',
      en: 'Check unfinished: reading the package took too long. Look at the result after installing.',
    }
  }
  return {
    zh: '没检查完，装完看一眼有没有报错。',
    en: 'Check unfinished. Look at the result after installing.',
  }
}
