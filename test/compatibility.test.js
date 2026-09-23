import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import semver from 'semver'
import { apply } from '../index.js'
import { renderIndexSection } from '../lib/inject.js'
import { MemoryStore } from '../lib/store.js'

function setup(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-compat-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let tool
  let section
  apply({
    effect: (fn) => fn(),
    tools: { register: (definition) => { tool = definition } },
    systemPrompt: { section: (definition) => { section = definition } },
  }, { dshHome: home, cwd: join(home, 'project'), ...config })
  return { tool, section }
}

const note = {
  action: 'write', name: 'port', type: 'project', description: 'Database port', content: 'port 5432 stays',
}

test('JSON Schema meta-validation and six-action round trip on the serialized tool contract', async (t) => {
  const { tool } = setup(t)
  const ajv = new Ajv({ strict: true, allErrors: true })
  const input = ajv.compile(JSON.parse(JSON.stringify(tool.parameters)))
  const output = ajv.compile(JSON.parse(JSON.stringify(tool.output.schema)))
  const calls = [
    note, { action: 'list' }, { action: 'list', type: 'project' },
    { action: 'read', names: ['port'] }, { action: 'search', query: '5432', limit: 1 },
    { action: 'edit', name: 'port', old_string: '5432', new_string: '5433' },
    { action: 'edit', name: 'port', old_string: ' stays', new_string: '' },
    { action: 'delete', name: 'port' },
  ]
  for (const args of calls) {
    assert.equal(input(args), true, JSON.stringify(input.errors))
    const result = await tool.execute(args)
    assert.equal(result.ok, true, result.message)
    assert.equal(output(result), true, JSON.stringify(output.errors))
    const rendered = tool.output.render(args, result)
    assert.ok(rendered.length > 0)
    assert.ok(rendered.every((block) => block.type === 'text' && typeof block.text === 'string'))
  }
})

test('malformed model arguments return schema-valid errors without modifying memories', async (t) => {
  const { tool } = setup(t)
  const ajv = new Ajv()
  const input = ajv.compile(tool.parameters)
  const output = ajv.compile(tool.output.schema)
  await tool.execute(note)
  const before = await tool.execute({ action: 'read', name: 'port' })
  const malformed = [
    undefined, null, [], '{"action":"delete","name":"port"}', 42,
    {}, { action: null }, { action: 'WRITE' },
    { ...note, scope: 12 }, { ...note, scope: 'layered' },
    { ...note, content: {} }, { ...note, description: null },
    { action: 'read', names: ['port', 12] },
    { action: 'edit', name: 'port', old_string: '5432', new_string: null },
    { action: 'edit', name: 'port', old_string: '5432', new_string: 1234 },
    { action: 'edit', name: 'port', old_string: '5432', new_string: '9999', replace_all: 'false' },
    { action: 'delete', name: 'port', dry_run: true },
    { action: 'search', query: 'port', limit: '10' },
  ]
  for (const args of malformed) {
    assert.equal(input(args), false, JSON.stringify(args))
    const result = await tool.execute(args)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(output(result), true, JSON.stringify(output.errors))
    assert.ok(tool.output.render(args, result)[0].text)
  }
  const after = await tool.execute({ action: 'read', name: 'port' })
  assert.deepEqual(after.documents, before.documents)
})

test('missing edit replacement cannot silently delete content; explicit empty string still works', async (t) => {
  const { tool } = setup(t)
  await tool.execute(note)
  const before = await tool.execute({ action: 'read', name: 'port' })
  for (const change of [
    { old_string: '5432' }, { new_string: '9999' },
    { old_string: '', new_string: '9999', description: 'changed' },
    { description: '', old_string: '5432', new_string: '9999' },
  ]) {
    const result = await tool.execute({ action: 'edit', name: 'port', ...change })
    assert.equal(result.ok, false, JSON.stringify(change))
  }
  assert.deepEqual((await tool.execute({ action: 'read', name: 'port' })).documents, before.documents)
  assert.equal((await tool.execute({ action: 'edit', name: 'port', old_string: ' stays', new_string: '' })).ok, true)
  assert.doesNotMatch((await tool.execute({ action: 'read', name: 'port' })).documents[0].content, /stays/u)
})

test('invalid search limits are actionable errors rather than silent defaults', async (t) => {
  const { tool } = setup(t)
  for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await tool.execute({ action: 'search', query: 'port', limit })
    assert.equal(result.ok, false)
    assert.match(result.message, /limit/u)
  }
})

test('whole index stays inside the UTF-8 budget, including oversized first notes and wrapper', () => {
  const entries = [
    { name: 'huge', description: '中文😀'.repeat(8000), type: 'user', layer: 'project', updated: 3 },
    { name: 'preference', description: '用中文', type: 'feedback', layer: 'global', updated: 2 },
    { name: 'reference', description: '文档', type: 'reference', layer: 'project', updated: 1 },
  ]
  for (const budget of [0, 1, 200, 400, 1024, 2048, 16384]) {
    const text = renderIndexSection(entries, budget)
    assert.ok(Buffer.byteLength(text, 'utf8') <= budget, `budget ${budget}`)
    assert.doesNotMatch(text, /- huge/u)
    if (text) {
      assert.match(text, /^<system-reminder>/u)
      assert.match(text, /<\/system-reminder>$/u)
      assert.match(text, /memories omitted/u)
    }
  }
  assert.match(renderIndexSection(entries, 2048), /- preference — 用中文 \[global\]/u)
  assert.match(renderIndexSection(entries, 2048), /- reference/u)
})

test('zero index budget disables injection without disabling memory tools', async (t) => {
  const { tool, section } = setup(t, { indexBudgetBytes: 0 })
  assert.equal((await tool.execute(note)).ok, true)
  assert.equal(section.text(), '')
  assert.equal((await tool.execute({ action: 'read', name: 'port' })).ok, true)
})

test('invalid index budgets fail during plugin setup', (t) => {
  for (const indexBudgetBytes of [-1, 1.5, '1000', Infinity, NaN]) {
    assert.throws(() => setup(t, { indexBudgetBytes }), /indexBudgetBytes/u)
  }
})

test('peer ranges include released dsh RC families and reject unrelated versions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/u, ''))
  for (const range of Object.values(pkg.peerDependencies)) {
    for (const version of ['0.1.0-rc.6', '0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.2']) {
      assert.equal(semver.satisfies(version, range), true, `${version} vs ${range}`)
    }
    for (const version of ['0.0.1-rc.1', '0.1.0-rc.2', '0.1.6-alpha.2', '0.2.0', '1.0.0']) {
      assert.equal(semver.satisfies(version, range), false, `${version} vs ${range}`)
    }
  }
})

test('batch read scans each active layer once and preserves backlink and missing-note results', async (t) => {
  const { tool } = setup(t)
  for (let i = 0; i < 10; i += 1) {
    await tool.execute({ ...note, name: `note-${i}`, content: 'See [[note-0]] and [[unwritten]].' })
  }
  const original = MemoryStore.prototype._scan
  const scan = t.mock.method(MemoryStore.prototype, '_scan', function (layer) {
    return original.call(this, layer)
  })
  const result = await tool.execute({ action: 'read', names: [
    ...Array.from({ length: 10 }, (_, i) => `note-${i}`), 'missing', 'note-0',
  ] })
  assert.equal(result.ok, true)
  assert.equal(result.documents.length, 10)
  assert.deepEqual(result.missing, ['missing'])
  assert.deepEqual(result.documents[0].backlinks, Array.from({ length: 9 }, (_, i) => `note-${i + 1}`))
  assert.deepEqual(result.documents[0].unwrittenLinks, ['unwritten'])
  assert.equal(scan.mock.callCount(), 2, '批量读取不应为每条记忆重扫两层目录')
})
