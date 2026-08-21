import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MemoryStore, INDEX_FILE } from '../lib/store.js'
import { resolveLayers, projectSlug, defaultWriteLayer } from '../lib/paths.js'
import { renderIndexSection } from '../lib/inject.js'

function setup(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  const cwd = join(home, 'proj')
  const layers = resolveLayers({ dshHome: home, ...config }, cwd)
  return {
    home,
    layers,
    store: new MemoryStore(layers),
    write: defaultWriteLayer(layers),
    projectDir: join(home, 'memory', projectSlug(cwd)),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function put(s, name, over = {}) {
  return s.store.write({
    name,
    description: `desc ${name}`,
    type: 'project',
    content: `body of ${name}`,
    layer: s.write,
    ...over,
  })
}

// ── 缓存 ─────────────────────────────────────────────────────────────────────

test('签名没变时不重读、不重解析（返回同一批对象）', () => {
  const s = setup()
  try {
    put(s, 'alpha')
    put(s, 'beta')

    const first = s.store.entries()
    const second = s.store.entries()
    assert.equal(first.length, 2)
    for (let i = 0; i < first.length; i += 1) {
      assert.equal(first[i], second[i], '第二次调用应直接命中缓存，返回同一个对象')
    }
  } finally {
    s.cleanup()
  }
})

test('签名不变就真的没读盘：内容被替换但 mtime/size 不变时，返回的仍是旧解析结果', () => {
  const s = setup()
  try {
    put(s, 'alpha')
    const path = s.store.entries()[0].path

    // mtime 先钉死在一个整毫秒上再预热缓存 —— utimesSync 只能写到毫秒精度，
    // 而 statSync 读回的是亚毫秒浮点，不先归整就没法在事后还原出同一个签名。
    const pinned = new Date(Math.floor(statSync(path).mtimeMs))
    utimesSync(path, pinned, pinned)
    const before = s.store.entries()
    assert.equal(before[0].description, 'desc alpha')

    // 等长替换内容，并把 mtime 拨回原值 —— 签名(名字+mtime+size)完全不变。
    const original = readFileSync(path, 'utf8')
    const tampered = original.replace('desc alpha', 'TAMPERED!!')
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original), '这个测试要求等长替换')
    writeFileSync(path, tampered, 'utf8')
    utimesSync(path, pinned, pinned)

    const after = s.store.entries()
    assert.equal(after[0], before[0], '签名不变 → 一次文件读都没发生')
    assert.equal(after[0].description, 'desc alpha')
  } finally {
    s.cleanup()
  }
})

test('外部进程改动会被 mtime/size 签名捕获', () => {
  const s = setup()
  try {
    put(s, 'alpha')
    const before = s.store.entries()[0]

    writeFileSync(
      before.path,
      '---\nname: alpha\ndescription: changed by someone else\nmetadata:\n  type: user\n---\n\nnew body\n',
      'utf8',
    )
    const future = new Date(Date.now() + 5000)
    utimesSync(before.path, future, future)

    const after = s.store.entries()[0]
    assert.notEqual(after, before, '变化过的文件必须重新解析')
    assert.equal(after.description, 'changed by someone else')
    assert.equal(after.type, 'user')
  } finally {
    s.cleanup()
  }
})

test('外部新增和删除都会被看到', () => {
  const s = setup()
  try {
    put(s, 'alpha')
    assert.equal(s.store.entries().length, 1)

    writeFileSync(
      join(s.projectDir, 'outside.md'),
      '---\nname: outside\ndescription: added out of band\nmetadata:\n  type: project\n---\n\nx\n',
      'utf8',
    )
    assert.deepEqual(s.store.entries().map((e) => e.name), ['alpha', 'outside'])

    rmSync(join(s.projectDir, 'outside.md'))
    assert.deepEqual(s.store.entries().map((e) => e.name), ['alpha'])
  } finally {
    s.cleanup()
  }
})

test('自己写的文件即使 mtime+size 都没变也不会读到旧值', () => {
  const s = setup()
  try {
    // 等长的两份内容，连续写入 —— 同一毫秒内 mtime 和 size 都可能完全一样。
    put(s, 'alpha', { content: 'AAAA' })
    assert.equal(s.store.entries()[0].body, 'AAAA')

    const path = s.store.entries()[0].path
    const st = statSync(path)
    put(s, 'alpha', { content: 'BBBB' })
    utimesSync(path, st.atime, st.mtime) // 把 mtime 也复原，制造最坏情况

    assert.equal(s.store.entries()[0].body, 'BBBB', '自己的写必须显式失效缓存')
  } finally {
    s.cleanup()
  }
})

test('目录不存在时是空库，不是异常', () => {
  const s = setup()
  try {
    assert.deepEqual(s.store.entries(), [])
    assert.equal(renderIndexSection(s.store.entries()), '')
  } finally {
    s.cleanup()
  }
})

test('稳态下 entries() 返回同一个数组，重复调用的开销可忽略', () => {
  const s = setup()
  try {
    for (let i = 0; i < 120; i += 1) put(s, `mem-${String(i).padStart(3, '0')}`)

    const a = s.store.entries()
    assert.equal(s.store.entries(), a, '无变化时应返回同一个数组对象，让调用方能跳过渲染')

    const started = process.hrtime.bigint()
    for (let i = 0; i < 300; i += 1) renderIndexSection(s.store.entries())
    const ms = Number(process.hrtime.bigint() - started) / 1e6

    // 每次全读全解析的实现在这里是 300 × 120 = 36000 次文件读，约 30 秒。
    // 这个上界宽到不会 flaky，但足以在缓存失效时立刻炸掉。
    assert.ok(ms < 5000, `300 次渲染耗时 ${ms.toFixed(0)}ms，缓存可能失效了`)
  } finally {
    s.cleanup()
  }
})

// ── 分层 ─────────────────────────────────────────────────────────────────────

test('项目层遮蔽全局层，且不影响其他条目', () => {
  const s = setup()
  try {
    const globalLayer = s.store.layerById('global')
    s.store.write({ name: 'shared', description: 'G', type: 'user', content: 'g', layer: globalLayer })
    s.store.write({ name: 'only-global', description: 'G2', type: 'user', content: 'g', layer: globalLayer })
    put(s, 'shared', { description: 'P' })

    const byName = new Map(s.store.entries().map((e) => [e.name, e]))
    assert.equal(byName.size, 2)
    assert.equal(byName.get('shared').description, 'P')
    assert.equal(byName.get('shared').layer, 'project')
    assert.equal(byName.get('only-global').layer, 'global')
  } finally {
    s.cleanup()
  }
})

test('每一层各自维护自己的 MEMORY.md 镜像', () => {
  const s = setup()
  try {
    put(s, 'alpha')
    const mirror = readFileSync(join(s.projectDir, INDEX_FILE), 'utf8')
    assert.match(mirror, /- \[alpha\]\(alpha\.md\) `project` — desc alpha/u)
  } finally {
    s.cleanup()
  }
})

// ── 检索与链接 ───────────────────────────────────────────────────────────────

test('search 按 名字 > description > 正文 加权，并尊重 limit', () => {
  const s = setup()
  try {
    put(s, 'redis-cache', { description: '缓存层', content: '无关正文' })
    put(s, 'other', { description: 'redis 相关', content: '无关正文' })
    put(s, 'third', { description: '别的', content: '里面提到 redis 一次' })

    const ranked = s.store.search('redis').map((r) => r.entry.name)
    assert.deepEqual(ranked, ['redis-cache', 'other', 'third'])
    assert.equal(s.store.search('redis', 2).length, 2)
    assert.equal(s.store.search('   ').length, 0)
  } finally {
    s.cleanup()
  }
})

test('多个词全命中的条目排在只命中一个词的前面', () => {
  const s = setup()
  try {
    put(s, 'both', { description: '无关', content: 'postgres 跑在 5433' })
    put(s, 'one', { description: '无关', content: 'postgres 而已' })

    assert.deepEqual(s.store.search('postgres 5433').map((r) => r.entry.name), ['both', 'one'])
  } finally {
    s.cleanup()
  }
})

test('反向链接与悬空链接都从缓存算出，不读盘', () => {
  const s = setup()
  try {
    put(s, 'target')
    put(s, 'referrer', { content: '依赖 [[target]] 与 [[ghost]]。' })

    assert.deepEqual(s.store.backlinks('target'), ['referrer'])
    assert.deepEqual(s.store.danglingLinks(['target', 'ghost']), ['ghost'])
  } finally {
    s.cleanup()
  }
})

test('超大记忆不进搜索缓存，但仍出现在索引里', () => {
  const s = setup()
  try {
    mkdirSync(s.projectDir, { recursive: true })
    writeFileSync(
      join(s.projectDir, 'huge.md'),
      `---\nname: huge\ndescription: 巨大的一条\nmetadata:\n  type: project\n---\n\n${'x'.repeat(70 * 1024)}\n`,
      'utf8',
    )
    const entry = s.store.entries().find((e) => e.name === 'huge')
    assert.ok(entry, '超大条目仍应出现在索引里')
    assert.equal(entry.oversized, true)
    assert.equal(entry.body, '', '正文不进内存缓存')
  } finally {
    s.cleanup()
  }
})
