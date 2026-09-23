// Run against an isolated installation: node scripts/host-smoke.mjs <host-directory>
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as memory from '../index.js'

const requireHost = createRequire(join(resolve(process.argv[2] ?? '.'), 'package.json'))
const load = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const host = await load('@deepseek-ai/dsh-tools')
const version = requireHost('@deepseek-ai/dsh-tools/package.json').version
const home = mkdtempSync(join(tmpdir(), 'dsh-memory-host-smoke-'))
const ctx = new Context()
try {
  new SystemPrompt(ctx, {})
  new host.default(ctx, {})
  const fiber = await ctx.plugin(memory, { dshHome: home, cwd: join(home, 'project'), maintenanceSkill: false })
  const tool = ctx.tools.get('memory')
  assert.ok(tool)
  const schemas = ctx.tools.schemas()
  assert.equal(schemas.length, 1)
  assert.equal(schemas[0].parameters.type, 'object')
  assert.deepEqual(schemas[0].parameters.required, ['action'])
  assert.equal(Object.hasOwn(schemas[0], 'execute'), false)
  host.assertSupportedJsonSchema(tool.output.schema)
  host.assertSupportedJsonSchema(tool.parameters)
  const sdkSchemas = [{ ...schemas[0], output: tool.output.schema }]
  assert.match(host.renderToolsSdk(sdkSchemas), /memory/u)
  assert.doesNotMatch(host.jsonSchemaToTs(tool.parameters), /unknown/u)
  if (host.renderToolsSdkPy) {
    assert.match(host.renderToolsSdkPy(sdkSchemas), /memory/u)
  }
  for (const args of [
    { action: 'write', name: 'host-note', type: 'project', description: 'Host smoke', content: 'port 5432' },
    { action: 'list' }, { action: 'read', name: 'host-note' },
    { action: 'search', query: '5432' },
    { action: 'edit', name: 'host-note', old_string: '5432', new_string: '5433' },
    { action: 'delete', name: 'host-note' },
  ]) {
    const result = await tool.execute(args)
    assert.equal(result.ok, true, result.message)
    assert.deepEqual(host.validateJsonSchemaValue(tool.output.schema, result), [])
    assert.equal(tool.output.render(args, result)[0].type, 'text')
    if (args.action === 'write') {
      assert.match(JSON.stringify(await ctx.systemPrompt.assemble()), /host-note/u)
    }
  }
  const prompt = await ctx.systemPrompt.assemble()
  assert.ok(prompt.tools.some((entry) => entry.name === 'memory'))
  assert.doesNotMatch(JSON.stringify(prompt), /host-note/u)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0)
  console.log(`dsh ${version}: registration, schema projection, six actions, output validation, prompt assembly and disposal passed`)
} finally {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
