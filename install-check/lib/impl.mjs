/**
 * Read the candidate's real source before it lands, and say only what can kill the
 * host: the shapes where activation itself throws, awaits forever, or takes the
 * process down. Same rule base as the CLI preflight (`lib/judge.mjs`), so a finding
 * here reads the same rule id and line as a manual check — this is not a second
 * opinion, it is the same one arriving at the moment somebody actually installs.
 *
 * Static text reading, bounded: no execution, no network, no writes. Anything that
 * only shows up at runtime (races, unbounded growth under load, a proxy fight between
 * two plugins) is outside what this can see and must not be promised.
 */
import { judgeDir } from '../../lib/judge.mjs'

const loud = new Set(['fatal', 'boot'])
const MAX = 2

function line(at, file) {
  return at ? `${file}:${at}` : file
}

/**
 * @param {string} dir package root that would be activated
 * @returns {{ruleId: string, severity: string, file: string, line: number, title: string, zh: string, en: string}[]}
 */
export function implementationRisks(dir) {
  if (!dir) return []
  let findings = []
  try {
    findings = judgeDir(dir)
  } catch {
    return []
  }
  const kept = findings
    .filter((finding) => loud.has(finding.severity))
    .sort((a, b) => (a.severity === 'fatal' ? 0 : 1) - (b.severity === 'fatal' ? 0 : 1) || (a.line ?? 0) - (b.line ?? 0))
  const shown = kept.slice(0, MAX)
  const extra = kept.length - shown.length
  return shown.map((finding) => {
    const where = line(finding.line, finding.file)
    const tail = extra > 0 && finding === shown[shown.length - 1] ? `（另有 ${extra} 处同类）` : ''
    return {
      ruleId: finding.ruleId,
      severity: finding.severity,
      file: finding.file,
      line: finding.line ?? 0,
      title: finding.title,
      zh: `装之前先读了源码：${finding.message} 改法：${finding.fix}${tail}`,
      en: `Before installing, ${where} hits a shape that kills the host: ${finding.title}. ${finding.fix}${extra > 0 ? ` (${extra} more like it)` : ''}`,
    }
  })
}

/** @returns {{zh: string, en: string}|null} */
export function renderImplementation(risks) {
  if (!risks?.length) return null
  return {
    zh: risks.map((risk) => risk.zh).join('\n'),
    en: risks.map((risk) => risk.en).join('\n'),
  }
}
