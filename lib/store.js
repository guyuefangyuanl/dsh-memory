/**
 * 记忆的读写与缓存。
 *
 * 性能上最要紧的一件事：索引注入发生在**每一次 prompt 组装**，也就是模型每走
 * 一步都会跑一遍。天真实现是"每次把目录里所有记忆全文读一遍再解析"，50 条记忆
 * 的会话跑 100 轮就是 5000 次全文件读 + 5000 次正则解析。
 *
 * 这里改成签名缓存：每次只对目录做 `readdir` + 每个文件一次 `stat`(不读内容)，
 * 拼成 `文件名:mtime:size` 的签名。签名没变就直接返回上次的结果 —— 稳态下
 * 零文件读、零解析、零字符串拼接。签名变了也只重读真正变过的那几个文件。
 *
 * 顺带的好处是 `search` 完全跑在缓存上，不碰磁盘。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { renderMemory, parseMemory, extractLinks, timestampOf, TYPES } from './frontmatter.js'

/** 人可读的镜像索引。模型看到的索引不从它来，见 README。 */
export const INDEX_FILE = 'MEMORY.md'
const INDEX_HEADING = '# Memory Index'

/** 单条记忆超过这个大小就不进搜索缓存 —— 记忆本该是短的，超了是误用。 */
const MAX_CACHED_BODY = 64 * 1024

/** 索引里的展示优先级，也是超预算时的保留优先级。 */
export const TYPE_ORDER = new Map(TYPES.map((t, i) => [t, i]))

function typeRank(type) {
  return TYPE_ORDER.get(type) ?? TYPE_ORDER.size
}

// ── 原子写 ───────────────────────────────────────────────────────────────────

let tmpCounter = 0

/** 写临时文件再 rename。中途挂掉时目标文件要么是旧内容，要么是新内容。 */
export function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.${(tmpCounter += 1)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清不掉临时文件不该盖住真正的失败原因。
    }
    throw err
  }
}

// ── 单层扫描 ─────────────────────────────────────────────────────────────────

function parseEntry(dir, layer, file, stat) {
  let text
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch {
    return null
  }
  const parsed = parseMemory(text)
  if (!parsed?.meta?.name) return null

  const { meta, body } = parsed
  const created = timestampOf(meta.created, stat.mtimeMs)
  const updated = timestampOf(meta.updated, stat.mtimeMs)
  const cacheable = stat.size <= MAX_CACHED_BODY

  return {
    file,
    layer,
    path: join(dir, file),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    name: meta.name,
    description: meta.description ?? '',
    type: meta.type ?? 'project',
    created,
    updated,
    links: cacheable ? extractLinks(body) : [],
    body: cacheable ? body : '',
    // 搜索只查这一个已经小写化的串，省掉每次查询的 toLowerCase。
    blob: `${meta.name}\n${meta.description ?? ''}\n${cacheable ? body : ''}`.toLowerCase(),
    oversized: !cacheable,
  }
}

// ── 存储 ─────────────────────────────────────────────────────────────────────

export class MemoryStore {
  /** @param layers 优先级升序，后面的遮蔽前面的。 */
  constructor(layers) {
    this.layers = layers
    /** dir → { signature, items } */
    this._cache = new Map()
    /** 合并后的结果，按各层签名记忆化。 */
    this._merged = null
  }

  /**
   * 扫描一层。签名命中就直接返回缓存 —— 这是热路径。
   * @returns 按 name 排序的条目数组。
   */
  _scan(layer) {
    const { dir } = layer
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 目录还不存在是正常状态(还没写过记忆)，不是错误。
      this._cache.delete(dir)
      return []
    }

    const stats = []
    const parts = []
    for (const entry of dirents) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === INDEX_FILE) continue
      let st
      try {
        st = statSync(join(dir, entry.name))
      } catch {
        continue
      }
      stats.push([entry.name, st])
      parts.push(`${entry.name}:${st.mtimeMs}:${st.size}`)
    }
    parts.sort()
    const signature = parts.join('|')

    const prev = this._cache.get(dir)
    if (prev && prev.signature === signature) return prev.items

    const reusable = new Map(prev ? prev.items.map((i) => [i.file, i]) : [])
    const items = []
    for (const [file, st] of stats) {
      const hit = reusable.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        items.push(hit)
        continue
      }
      const parsed = parseEntry(dir, layer.id, file, st)
      if (parsed) items.push(parsed)
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    this._cache.set(dir, { signature, items })
    return items
  }

  /**
   * 所有层合并。同名时高优先级层(靠后)遮蔽低优先级层。
   *
   * 内容没变时返回**同一个数组对象** —— 调用方(索引注入)据此跳过整段渲染，
   * 于是稳态下每次组装只剩 readdir + stat，合并、排序、拼串全都不做。
   */
  entries() {
    // 先扫，再取签名 —— _scan 才是刷新签名的那一步。
    const scanned = this.layers.map((layer) => this._scan(layer))
    const key = this.layers.map((l) => `${l.id}=${this._signatureOf(l.dir)}`).join('\n')
    if (this._merged && this._merged.key === key) return this._merged.items

    const merged = new Map()
    for (const items of scanned) {
      for (const item of items) merged.set(item.name, item)
    }
    const items = [...merged.values()].sort(
      (a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name),
    )
    this._merged = { key, items }
    return items
  }

  _signatureOf(dir) {
    return this._cache.get(dir)?.signature ?? ''
  }

  entry(name) {
    let found = null
    for (const layer of this.layers) {
      for (const item of this._scan(layer)) {
        if (item.name === name) found = item
      }
    }
    return found
  }

  layerById(id) {
    return this.layers.find((l) => l.id === id) ?? null
  }

  /**
   * 自己刚写过的文件必须显式失效，不能只靠签名。
   *
   * 签名用的是 mtime+size：同一毫秒内把一条记忆改成等长的另一份内容，两者都不变，
   * 缓存就会漏掉这次修改。外部进程的写不会这么巧，自己的写会 —— 所以自己写完
   * 直接把这个文件从缓存里摘掉，其余文件仍然复用，不必整层重解析。
   */
  _invalidate(dir, file) {
    const prev = this._cache.get(dir)
    if (!prev) return
    this._cache.set(dir, { signature: null, items: prev.items.filter((i) => i.file !== file) })
  }

  /** 指向这条记忆的其他记忆 —— 全部来自缓存，不读盘。 */
  backlinks(name) {
    return this.entries()
      .filter((e) => e.name !== name && e.links.includes(name))
      .map((e) => e.name)
  }

  /** 记忆库里不存在的 `[[链接]]`。 */
  danglingLinks(links) {
    const known = new Set(this.entries().map((e) => e.name))
    return links.filter((l) => !known.has(l))
  }

  // ── 写 ─────────────────────────────────────────────────────────────────────

  write({ name, description, type, content, layer }) {
    const dir = layer.dir
    const basename = `${name}.md`
    const file = join(dir, basename)
    // 同名更新要保住 created，否则每次改写都把"什么时候第一次知道这件事"抹掉。
    const existing = this.entry(name)
    const previousCreated =
      existing && existing.layer === layer.id ? new Date(existing.created).toISOString() : undefined

    mkdirSync(dir, { recursive: true })
    const existed = existsSync(file)
    atomicWrite(
      file,
      renderMemory({
        name,
        description,
        type,
        body: content,
        created: existed ? previousCreated : undefined,
      }),
    )
    this._invalidate(dir, basename)
    this.rebuildIndex(layer)
    return { existed }
  }

  remove(name) {
    const entry = this.entry(name)
    if (!entry) return null
    rmSync(entry.path, { force: true })
    const layer = this.layerById(entry.layer)
    if (layer) {
      this._invalidate(layer.dir, entry.file)
      this.rebuildIndex(layer)
    }
    return entry
  }

  /**
   * 重建人可读的 `MEMORY.md`。索引是派生物 —— 从磁盘上真实存在的文件重建，
   * 不做增量维护，所以并发写、手改坏、进程中途挂掉都不会让它长期失配。
   */
  rebuildIndex(layer) {
    const items = this._scan(layer)
    const lines = [
      INDEX_HEADING,
      '',
      '<!-- 由 dsh-memory 自动重建。手工编辑不会影响模型看到的内容 —— 注入的索引',
      '     是每次组装时从下面这些 .md 文件本身重新扫出来的，不读这个文件。 -->',
      '',
    ]
    for (const it of items) lines.push(`- [${it.name}](${it.file}) \`${it.type}\` — ${it.description}`)
    try {
      mkdirSync(layer.dir, { recursive: true })
      atomicWrite(join(layer.dir, INDEX_FILE), `${lines.join('\n')}\n`)
    } catch {
      // 镜像索引写不出来不该让 write 失败 —— 真正的记忆已经落盘了。
    }
    return items.length
  }

  // ── 搜索 ───────────────────────────────────────────────────────────────────

  /**
   * 子串匹配而不是分词匹配：中文没有空格，英文的 `deploy` 也该命中
   * `deployment`。名字命中权重最高，其次 description，最后正文。
   */
  search(query, limit = 10) {
    const terms = String(query)
      .toLowerCase()
      .split(/[\s,;、，。]+/u)
      .map((t) => t.trim())
      .filter(Boolean)
    if (terms.length === 0) return []

    const scored = []
    for (const entry of this.entries()) {
      let score = 0
      let matched = 0
      let anchor = -1
      for (const term of terms) {
        const inName = entry.name.toLowerCase().includes(term)
        const inDesc = entry.description.toLowerCase().includes(term)
        const at = entry.body.toLowerCase().indexOf(term)
        if (!inName && !inDesc && at < 0) continue
        matched += 1
        if (inName) score += 8
        if (inDesc) score += 4
        if (at >= 0) {
          score += 1
          if (anchor < 0) anchor = at
        }
      }
      if (matched === 0) continue
      // 全部词都命中的条目排在只命中一个词的前面。
      score += matched === terms.length ? 5 : 0
      scored.push({ entry, score, snippet: snippetAround(entry.body, anchor) })
    }

    scored.sort((a, b) => b.score - a.score || b.entry.updated - a.entry.updated)
    return scored.slice(0, Math.max(1, limit))
  }
}

function snippetAround(body, at, radius = 70) {
  if (!body) return ''
  const start = at < 0 ? 0 : Math.max(0, at - radius)
  const end = at < 0 ? Math.min(body.length, radius * 2) : Math.min(body.length, at + radius)
  const cut = body.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${cut}${end < body.length ? '…' : ''}`
}
