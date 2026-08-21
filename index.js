/**
 * dsh-memory —— DeepSeek Harness 的跨会话持久记忆。
 *
 * 两个部件：
 *   1. 一个 `memory` 工具，模型自己判断值得记什么，自己写入 / 读取 / 检索 / 删除。
 *   2. 一个常驻 system-prompt section，把索引(不含正文)注入每一次组装。
 *
 * 落盘在 `$DSH_HOME/memory/` 下的两层：`global/` 跨项目共享，`<项目 slug>/` 按
 * cwd 隔离。默认两层都可见，同名时项目层遮蔽全局层。
 *
 * 详见 README。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAYERS, resolveLayers, defaultWriteLayer } from './lib/paths.js'
import { TYPES, NAME_RE, parseMemory, ageInDays } from './lib/frontmatter.js'
import { MemoryStore } from './lib/store.js'
import { renderIndexSection, MAX_INDEX_BYTES } from './lib/inject.js'

const packageRoot = dirname(fileURLToPath(import.meta.url))

/** description 相似到这个程度就提示可能是重复条目 —— 提示而已，不拦。 */
const DUPLICATE_THRESHOLD = 0.5

/** 超过这个天数，read 会在结果里点明这条记忆有多旧。 */
const STALE_AFTER_DAYS = 14

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

// ── 近重复检测 ───────────────────────────────────────────────────────────────

/** 中文没有空格，所以 CJK 按连续两字的 bigram 取词，拉丁按词。 */
function tokenize(text) {
  const s = String(text).toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9]{2,}/gu) ?? []) out.add(w)
  for (const run of s.match(/[一-鿿]+/gu) ?? []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / (a.size + b.size - shared)
}

function findNearDuplicates(store, { name: memName, description }) {
  const probe = tokenize(`${memName} ${description}`)
  return store
    .entries()
    .filter((e) => e.name !== memName)
    .map((e) => ({ name: e.name, score: jaccard(probe, tokenize(`${e.name} ${e.description}`)) }))
    .filter((c) => c.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.name)
}

// ── 捆绑的维护技能(可选) ──────────────────────────────────────────────────────

/** 技能服务不一定挂载。加载失败不该让记忆功能本身起不来。 */
export function loadMaintenanceSkill() {
  const skillsRoot = join(packageRoot, 'skills')
  if (!existsSync(skillsRoot)) return null
  const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (dirs.length !== 1) return null
  const skillDir = join(skillsRoot, dirs[0].name)
  const skillPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillPath)) return null

  const parsed = parseMemory(readFileSync(skillPath, 'utf8'))
  if (!parsed?.meta?.name || !parsed.meta.description) return null
  if (parsed.meta.name !== dirs[0].name) return null

  return {
    name: parsed.meta.name,
    description: parsed.meta.description,
    content: parsed.body,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: name,
    path: skillPath,
    resourceBase: { kind: 'directory', path: skillDir },
  }
}

// ── 工具描述 ─────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = [
  'Durable notes that outlive this session. One note holds one fact.',
  '',
  'Worth saving: something that will still be true and still be useful weeks from now, and that a',
  'future session could not work out on its own. Not worth saving: anything the repository already',
  'states — file layout, APIs, commit history, what the contributor guide says — or detail that only',
  'matters until this task is finished.',
  '',
  'Pick a `type` by what the fact is about. `user`: who you are working with — their role, what they',
  'already know, how they like to be addressed. `feedback`: a working instruction they gave you, kept',
  'together with the reason behind it, so a later session can tell when it stops applying. `project`:',
  'the state of the work — goals, constraints, decisions already made. Date these absolutely; "last',
  'week" is meaningless on replay. `reference`: where something external lives — a URL, a dashboard, a',
  'ticket.',
  '',
  'Two places to write. `project` (the default) keeps the note to this working directory. `global`',
  'shares it with every project — right for who the person is, wrong for what this repo is doing.',
  '',
  'Before writing, `search` for what you are about to record. Sharpening the note that already covers',
  'it beats leaving two half-notes that disagree. To correct part of a note, `edit` it by quoting the',
  'exact text to replace, rather than resending the whole thing through `write`. When a note turns out',
  'to be wrong, `delete` it — a stale memory costs more than a missing one.',
  '',
  'Cross-reference freely as [[their-name]], including names you have not written yet. An unwritten',
  'link is not a mistake: it records that the fact is worth capturing, and `list` returns those names',
  'as a backlog so a later session can work through them.',
].join('\n')

// ── 插件 ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  if (!ctx?.tools?.register) throw new Error(`${name}: ctx.tools is required`)
  if (!ctx?.systemPrompt?.section) throw new Error(`${name}: ctx.systemPrompt is required`)
  if (!ctx?.effect) throw new Error(`${name}: ctx.effect is required`)

  const cwd = config.cwd ?? process.env.DSH_CWD ?? process.cwd()
  const layers = resolveLayers(config, cwd)
  const store = new MemoryStore(layers)
  const writeLayer = defaultWriteLayer(layers)
  const budget = Number.isFinite(config.indexBudgetBytes) ? config.indexBudgetBytes : MAX_INDEX_BYTES

  // ── 索引注入 ───────────────────────────────────────────────────────────────
  // order 50：persona(0) 之后、工具指引(100+) 之前。
  // text 是 provider，每次组装都重新求值 —— 靠 store 的签名缓存做到"实时但不昂贵"：
  // 刚写入的记忆下一步就可见，而没变化时一次文件都不读。entries() 在无变化时返回
  // 同一个数组对象，所以这里连渲染本身都跳过。
  let rendered = { entries: null, text: '' }
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'memory:index',
        order: 50,
        text: () => {
          try {
            const entries = store.entries()
            if (entries !== rendered.entries) {
              rendered = { entries, text: renderIndexSection(entries, budget) }
            }
            return rendered.text
          } catch {
            // 记忆坏了不该让整个会话起不来。
            return ''
          }
        },
      }),
    `${name}: register memory index section`,
  )

  // ── memory 工具 ────────────────────────────────────────────────────────────
  ctx.effect(
    () => ctx.tools.register(defineMemoryTool({ store, layers, writeLayer })),
    `${name}: register memory tool`,
  )

  // ── 维护技能(有 skills 服务才注册) ─────────────────────────────────────────
  if (config.maintenanceSkill !== false && typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      const skill = loadMaintenanceSkill()
      if (!skill || !skillCtx?.skills?.register) return
      skillCtx.effect(() => skillCtx.skills.register(skill), `${name}: register ${skill.name}`)
    })
  }
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

function defineMemoryTool({ store, layers, writeLayer }) {
  const layerIds = layers.map((l) => l.id)

  return {
    name: 'memory',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['write', 'read', 'list', 'search', 'edit', 'delete'],
        description:
          'write (create or replace one note) | read (load notes in full) | list (every note, index form) | search (match on content) | edit (change part of an existing note) | delete (remove one).',
      },
      name: {
        type: 'string',
        description:
          'Lowercase kebab-case identifier. Required for write, edit, and delete; for read, use this or `names`.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Read several notes in one call instead of one round trip each.',
      },
      description: {
        type: 'string',
        description:
          'One line, shown in the always-loaded index. It is the only thing a future session sees before deciding whether to open this note, so make it say what the note settles, not what topic it is near. Required for write; on edit, replaces the existing one.',
      },
      type: {
        type: 'string',
        enum: [...TYPES],
        description:
          'Required for write. On edit, reclassifies the note. On list, restricts the result to one type.',
      },
      old_string: {
        type: 'string',
        description:
          'edit only: the exact text to replace, copied from the note body. Must appear exactly once unless replace_all is set. Only the body is searched, so an edit can never damage the frontmatter.',
      },
      new_string: {
        type: 'string',
        description: 'edit only: what old_string becomes. Pass an empty string to delete that text.',
      },
      replace_all: {
        type: 'boolean',
        description: 'edit only: replace every occurrence instead of requiring old_string to be unique.',
      },
      content: {
        type: 'string',
        description:
          'The note itself. For feedback and project notes, state the fact, then a "Why:" line and a "How to apply:" line so a later session can act on it without guessing.',
      },
      scope: {
        type: 'string',
        enum: [...LAYERS],
        description: `Where to write: project (this working directory) or global (every project). Default ${writeLayer.id}.`,
      },
      query: {
        type: 'string',
        description: 'Required for search. Words are matched as substrings against name, description, and body.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum search results (default 10).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ok', 'message'],
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          message: { type: 'string' },
          count: { type: 'integer' },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'description', 'scope'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                scope: { type: 'string' },
                updatedDaysAgo: { type: 'integer' },
              },
            },
          },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'content'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                scope: { type: 'string' },
                content: { type: 'string' },
                updatedDaysAgo: { type: 'integer' },
                links: { type: 'array', items: { type: 'string' } },
                unwrittenLinks: { type: 'array', items: { type: 'string' } },
                backlinks: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'description'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                scope: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          unwritten: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'from'],
              properties: {
                name: { type: 'string' },
                from: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          missing: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderToolResult,
    },
    execute: async (args) => executeMemory({ store, layerIds, writeLayer }, args ?? {}),
  }
}

// ── 执行 ─────────────────────────────────────────────────────────────────────

function executeMemory({ store, layerIds, writeLayer }, a) {
  const action = a.action

  if (action === 'list') return doList(store, a)
  if (action === 'search') return doSearch(store, a)
  if (action === 'read') return doRead(store, a)
  if (action === 'write') return doWrite(store, layerIds, writeLayer, a)
  if (action === 'edit') return doEdit(store, a)
  if (action === 'delete') return doDelete(store, a)
  return { action: String(action), ok: false, message: `Unknown action "${action}".` }
}

function summarize(entry) {
  return {
    name: entry.name,
    type: entry.type,
    description: entry.description,
    scope: entry.layer,
    updatedDaysAgo: ageInDays(entry.updated),
  }
}

function doList(store, a) {
  const filter = typeof a.type === 'string' && a.type ? a.type : null
  if (filter && !TYPES.includes(filter)) {
    return { action: 'list', ok: false, message: `type must be one of: ${TYPES.join(', ')}` }
  }
  const items = store.entries().filter((e) => !filter || e.type === filter)
  // 待写清单只在看全量时才有意义 —— 按 type 过滤时它和结果对不上。
  const unwritten = filter ? [] : store.unwrittenLinks()
  const parts = [`${items.length} ${filter ? `${filter} ` : ''}memories.`]
  if (unwritten.length > 0) {
    parts.push(
      `${unwritten.length} name${unwritten.length === 1 ? ' is' : 's are'} linked to but not written yet — a backlog, not an error.`,
    )
  }
  return {
    action: 'list',
    ok: true,
    message: parts.join(' '),
    count: items.length,
    memories: items.map(summarize),
    ...(unwritten.length > 0 ? { unwritten } : {}),
  }
}

function doSearch(store, a) {
  const query = typeof a.query === 'string' ? a.query.trim() : ''
  if (!query) return { action: 'search', ok: false, message: 'query is required for search.' }
  const limit = Number.isInteger(a.limit) && a.limit > 0 ? a.limit : 10

  const hits = store.search(query, limit)
  return {
    action: 'search',
    ok: true,
    message:
      hits.length === 0
        ? `Nothing matches "${query}". Either it was never recorded, or it is worded differently — try a broader term or \`list\`.`
        : `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}".`,
    count: hits.length,
    results: hits.map(({ entry, snippet }) => ({
      name: entry.name,
      type: entry.type,
      description: entry.description,
      scope: entry.layer,
      snippet,
    })),
  }
}

function doRead(store, a) {
  const requested = []
  if (Array.isArray(a.names)) {
    for (const n of a.names) if (typeof n === 'string' && n.trim()) requested.push(n.trim())
  }
  if (typeof a.name === 'string' && a.name.trim()) requested.push(a.name.trim())
  const unique = [...new Set(requested)]
  if (unique.length === 0) return { action: 'read', ok: false, message: 'name or names is required for read.' }

  const documents = []
  const missing = []
  for (const memName of unique) {
    if (!NAME_RE.test(memName)) {
      missing.push(memName)
      continue
    }
    const entry = store.entry(memName)
    if (!entry) {
      missing.push(memName)
      continue
    }
    let content
    try {
      content = readFileSync(entry.path, 'utf8')
    } catch {
      missing.push(memName)
      continue
    }
    const known = new Set(store.entries().map((e) => e.name))
    documents.push({
      name: entry.name,
      type: entry.type,
      scope: entry.layer,
      content,
      updatedDaysAgo: ageInDays(entry.updated),
      links: entry.links,
      unwrittenLinks: entry.links.filter((l) => !known.has(l)),
      backlinks: store.backlinks(entry.name),
    })
  }

  const parts = [`Loaded ${documents.length} of ${unique.length}.`]
  if (missing.length > 0) parts.push(`No memory named: ${missing.join(', ')}.`)
  return {
    action: 'read',
    ok: documents.length > 0,
    message: parts.join(' '),
    count: documents.length,
    documents,
    ...(missing.length > 0 ? { missing } : {}),
  }
}

function doWrite(store, layerIds, writeLayer, a) {
  const memName = typeof a.name === 'string' ? a.name.trim() : ''
  if (!memName) return { action: 'write', ok: false, message: 'name is required for write.' }
  if (!NAME_RE.test(memName)) {
    return {
      action: 'write',
      ok: false,
      message: `Invalid name "${memName}". Use lowercase kebab-case: [a-z0-9][a-z0-9-]*`,
    }
  }

  const description = typeof a.description === 'string' ? a.description.trim() : ''
  const type = typeof a.type === 'string' ? a.type.trim() : ''
  const content = typeof a.content === 'string' ? a.content.trim() : ''
  if (!description) return { action: 'write', ok: false, message: 'description is required for write.' }
  if (!TYPES.includes(type)) {
    return { action: 'write', ok: false, message: `type must be one of: ${TYPES.join(', ')}` }
  }
  if (!content) return { action: 'write', ok: false, message: 'content is required for write.' }

  let target = writeLayer
  if (typeof a.scope === 'string' && a.scope) {
    if (!layerIds.includes(a.scope)) {
      return {
        action: 'write',
        ok: false,
        message: `scope "${a.scope}" is not active in this deployment (available: ${layerIds.join(', ')}).`,
      }
    }
    target = store.layerById(a.scope)
  }

  // 重复提示要在写之前算，否则新写的这条会把自己算进候选。
  const duplicates = findNearDuplicates(store, { name: memName, description })

  const { existed } = store.write({ name: memName, description, type, content, layer: target })

  const warnings = []
  if (!existed && duplicates.length > 0) {
    warnings.push(
      `Reads close to existing ${duplicates.length === 1 ? 'memory' : 'memories'}: ${duplicates.join(', ')}. If it is the same fact, merge and delete the loser.`,
    )
  }

  const total = store.entries().length
  // 项目层是默认落点，只有落到全局层才值得在消息里点出来 —— 否则 type 和
  // scope 都叫 "project" 时会读成 "(project, project)"。
  const where = target.id === 'global' ? ', global scope' : ''
  return {
    action: 'write',
    ok: true,
    message: `${existed ? 'Updated' : 'Saved'} "${memName}" (${type}${where}). ${total} memories total.`,
    count: total,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** `String.replace` 会把 `$&`、`$1` 当替换模式解释，所以按下标切片，不用它。 */
function spliceOnce(text, needle, replacement) {
  const at = text.indexOf(needle)
  return text.slice(0, at) + replacement + text.slice(at + needle.length)
}

function doEdit(store, a) {
  const memName = typeof a.name === 'string' ? a.name.trim() : ''
  if (!memName) return { action: 'edit', ok: false, message: 'name is required for edit.' }
  if (!NAME_RE.test(memName)) {
    return { action: 'edit', ok: false, message: `Invalid name "${memName}".` }
  }
  const entry = store.entry(memName)
  if (!entry) {
    return {
      action: 'edit',
      ok: false,
      message: `No memory named "${memName}". Use write to create it.`,
    }
  }

  const oldString = typeof a.old_string === 'string' ? a.old_string : ''
  const newString = typeof a.new_string === 'string' ? a.new_string : ''
  const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined
  const rawType = typeof a.type === 'string' && a.type.trim() ? a.type.trim() : undefined
  if (rawType && !TYPES.includes(rawType)) {
    return { action: 'edit', ok: false, message: `type must be one of: ${TYPES.join(', ')}` }
  }

  const changesBody = oldString.length > 0
  if (!changesBody && !description && !rawType) {
    return {
      action: 'edit',
      ok: false,
      message:
        'edit needs old_string (with new_string), or a new description or type. To replace a memory outright, use write.',
    }
  }

  let body = store.bodyOf(entry)
  let replaced = 0
  if (changesBody) {
    if (oldString === newString) {
      return { action: 'edit', ok: false, message: 'old_string and new_string are identical — nothing to do.' }
    }
    const hits = body.split(oldString).length - 1
    if (hits === 0) {
      return {
        action: 'edit',
        ok: false,
        message: `old_string does not appear in "${memName}". Read it first and copy the text exactly, whitespace included. Only the body is searched — frontmatter is not editable this way.`,
      }
    }
    if (hits > 1 && a.replace_all !== true) {
      return {
        action: 'edit',
        ok: false,
        message: `old_string appears ${hits} times in "${memName}". Include enough surrounding text to make it unique, or pass replace_all: true.`,
      }
    }
    body = a.replace_all === true ? body.split(oldString).join(newString) : spliceOnce(body, oldString, newString)
    replaced = a.replace_all === true ? hits : 1
    body = body.trim()
    if (!body) {
      return {
        action: 'edit',
        ok: false,
        message: `That would leave "${memName}" with no content. Use delete if the memory no longer holds.`,
      }
    }
  }

  store.update({ name: memName, body, description, type: rawType })

  const changed = []
  if (changesBody) changed.push(`replaced ${replaced} occurrence${replaced === 1 ? '' : 's'}`)
  if (description) changed.push('new description')
  if (rawType) changed.push(`type → ${rawType}`)

  return {
    action: 'edit',
    ok: true,
    message: `Edited "${memName}" (${changed.join(', ')}).`,
    count: store.entries().length,
  }
}

function doDelete(store, a) {
  const memName = typeof a.name === 'string' ? a.name.trim() : ''
  if (!memName) return { action: 'delete', ok: false, message: 'name is required for delete.' }
  if (!NAME_RE.test(memName)) {
    return { action: 'delete', ok: false, message: `Invalid name "${memName}".` }
  }

  const referrers = store.backlinks(memName)
  const removed = store.remove(memName)
  if (!removed) return { action: 'delete', ok: false, message: `No memory named "${memName}".` }

  const total = store.entries().length
  // 引用一条不存在的记忆本身没问题 —— 但如果这件事是搬走了而不是不成立了，
  // 那些引用应该指向新的落点，所以这里点名让人决定，而不是当成坏链报警。
  const one = referrers.length === 1
  const warnings =
    referrers.length > 0
      ? [
          `${referrers.join(', ')} still ${one ? 'links' : 'link'} to [[${memName}]]. That is only a backlog entry now; if the fact moved rather than stopped being true, repoint ${one ? 'it' : 'them'} at wherever it went.`,
        ]
      : []
  return {
    action: 'delete',
    ok: true,
    message: `Deleted "${memName}" from ${removed.layer}. ${total} memories remain.`,
    count: total,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── 结果投影 ─────────────────────────────────────────────────────────────────

function renderToolResult(_args, value) {
  const v = value ?? {}
  const lines = []

  if (v.action === 'list' && Array.isArray(v.memories)) {
    lines.push(
      v.memories.length === 0
        ? 'No memories saved yet.'
        : v.memories
            .map((m) => `- ${m.name} (${m.type}${m.scope === 'global' ? ', global' : ''}) — ${m.description}`)
            .join('\n'),
    )
    if (Array.isArray(v.unwritten) && v.unwritten.length > 0) {
      lines.push('')
      lines.push('linked to but not written yet (worth capturing, in rough order of demand):')
      for (const u of v.unwritten) lines.push(`- ${u.name} — referenced by ${u.from.join(', ')}`)
    }
  } else if (v.action === 'search' && Array.isArray(v.results)) {
    lines.push(String(v.message ?? ''))
    for (const r of v.results) {
      lines.push(`- ${r.name} (${r.type}) — ${r.description}`)
      if (r.snippet) lines.push(`    ${r.snippet}`)
    }
  } else if (v.action === 'read' && Array.isArray(v.documents)) {
    for (const d of v.documents) {
      const age =
        typeof d.updatedDaysAgo === 'number'
          ? d.updatedDaysAgo === 0
            ? 'updated today'
            : `updated ${d.updatedDaysAgo} day${d.updatedDaysAgo === 1 ? '' : 's'} ago`
          : ''
      lines.push(`── ${d.name} (${d.type}${d.scope === 'global' ? ', global' : ''}${age ? `, ${age}` : ''}) ──`)
      lines.push(d.content.trim())
      if (Array.isArray(d.backlinks) && d.backlinks.length > 0) {
        lines.push(`referenced by: ${d.backlinks.join(', ')}`)
      }
      if (Array.isArray(d.unwrittenLinks) && d.unwrittenLinks.length > 0) {
        lines.push(`links to memories not written yet: ${d.unwrittenLinks.join(', ')}`)
      }
      if (typeof d.updatedDaysAgo === 'number' && d.updatedDaysAgo >= STALE_AFTER_DAYS) {
        lines.push(
          `(Recorded ${d.updatedDaysAgo} days ago. Check anything it names still exists before acting on it.)`,
        )
      }
      lines.push('')
    }
    if (Array.isArray(v.missing) && v.missing.length > 0) lines.push(`not found: ${v.missing.join(', ')}`)
    if (lines.length === 0) lines.push(String(v.message ?? ''))
  } else {
    lines.push(String(v.message ?? ''))
  }

  if (Array.isArray(v.warnings)) for (const w of v.warnings) lines.push(`! ${w}`)

  return [{ type: 'text', text: lines.join('\n').trim() }]
}
