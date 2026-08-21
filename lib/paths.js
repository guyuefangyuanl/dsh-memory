/**
 * 记忆落盘位置的推导。
 *
 * 两层：`global`(跨项目共享) 和 `project`(按 cwd 隔离)。默认两层同时可见，
 * 同名时项目层遮蔽全局层 —— 这样"这个人是谁"可以写一次全项目通用，
 * 而"这个仓库在做什么"仍然不会串味。
 */

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 单层模式与双层模式。`layered` 是默认。 */
export const SCOPES = ['layered', 'project', 'global']

/** 写入目标只能是一个具体的层。 */
export const LAYERS = ['project', 'global']

export function dshHome(config = {}) {
  const raw = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  if (raw.startsWith('~')) return join(homedir(), raw.slice(1).replace(/^[\\/]/u, ''))
  return resolve(raw)
}

/**
 * cwd → 稳定且文件名安全的 slug。`C:\Users\x\repo` → `C--Users-x-repo`
 *
 * 只做字符替换，不做哈希：目录名对人可读，出问题时能直接在文件管理器里找到。
 */
export function projectSlug(cwd) {
  const s = resolve(cwd)
    .replace(/[:\\/]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{3,}/gu, '--')
  return s.slice(0, 120) || 'default'
}

/**
 * 解析出本次生效的层，**按优先级升序** —— 后面的遮蔽前面的。
 *
 * @returns 形如 `[{ id: 'global', dir }, { id: 'project', dir }]`
 */
export function resolveLayers(config = {}, cwd = process.cwd()) {
  const root = join(dshHome(config), 'memory')
  const globalLayer = { id: 'global', dir: join(root, 'global') }
  const projectLayer = { id: 'project', dir: join(root, projectSlug(cwd)) }

  const scope = config.scope ?? 'layered'
  if (scope === 'project') return [projectLayer]
  if (scope === 'global') return [globalLayer]
  if (scope === 'layered') return [globalLayer, projectLayer]
  throw new Error(`dsh-memory: unknown scope "${scope}" (expected one of: ${SCOPES.join(', ')})`)
}

/** 写入默认落在优先级最高的层 —— 双层时是 project，单层时就是那一层。 */
export function defaultWriteLayer(layers) {
  return layers[layers.length - 1]
}
