/**
 * 单条记忆的磁盘格式：YAML frontmatter + Markdown 正文。
 *
 * 解析刻意宽松 —— 记忆文件是人也会手改的。缺字段、缩进不对、多余的键都
 * 不该让整条记忆消失；只有"连 frontmatter 都没有"才算损坏。
 */

/** 记忆的四种用途。 */
export const TYPES = ['user', 'feedback', 'project', 'reference']

/** 文件名安全 + 可读：小写 kebab-case。同时排除了 `..` 和路径分隔符。 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/u

/** 正文里的互链写法：`[[other-memory]]`。 */
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/gu

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u

/** description 是单行的 —— 换行会破坏 frontmatter，落盘前压平。 */
function flatten(text) {
  return String(text).replace(/\s*[\r\n]+\s*/gu, ' ').trim()
}

export function renderMemory({ name, description, type, body, created, updated }) {
  const now = new Date().toISOString()
  return [
    '---',
    `name: ${name}`,
    `description: ${flatten(description)}`,
    'metadata:',
    `  type: ${type}`,
    `  created: ${created ?? now}`,
    `  updated: ${updated ?? now}`,
    '---',
    '',
    String(body).trim(),
    '',
  ].join('\n')
}

/**
 * @returns `{ meta, body }`，或 `null` 表示这个文件不是一条记忆。
 */
export function parseMemory(text) {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split(/\r?\n/u)) {
    const i = line.indexOf(':')
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (!value) continue
    // 缩进不参与判断：`type` 既可能在 metadata 下，也可能是老文件的顶层键。
    if (key === 'name' || key === 'description' || key === 'type') {
      if (meta[key] === undefined) meta[key] = value
    } else if (key === 'created' || key === 'updated') {
      if (meta[key] === undefined) meta[key] = value
    }
  }
  return { meta, body: m[2].trim() }
}

/** 正文里指向的其他记忆名，去重且保序。 */
export function extractLinks(body) {
  const out = []
  for (const m of String(body).matchAll(LINK_RE)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * frontmatter 里的时间戳可能缺失或被手改坏，落回文件 mtime 而不是抛错。
 * @returns 毫秒时间戳。
 */
export function timestampOf(value, fallbackMs) {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return fallbackMs
}

/** 给模型看的"这条有多旧"。 */
export function ageInDays(ms, now = Date.now()) {
  return Math.max(0, Math.floor((now - ms) / 86_400_000))
}
