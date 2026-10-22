// 工具面探针：用最小宿主 stub 加载插件，枚举真正注册上去的工具与系统提示贡献。
// 目的：在没有 DSH 运行时的环境里，也能回答「装上去到底有几个工具、注入有没有注册」。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PLUGIN = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const HOME = join(tmpdir(), `dsbot-surface-${Date.now()}`)
process.env.DSH_HOME = HOME
await mkdir(join(HOME, 'bot-ours'), { recursive: true })

const registered = new Map()
const sections = []
const contexts = []
const disposers = []

const ctx = {
  tools: { register: def => (registered.set(def.name, def), () => registered.delete(def.name)) },
  get: () => undefined,
  effect: fn => {
    const d = fn()
    disposers.push(d)
    return () => {}
  },
  inject: (deps, cb) => {
    cb({
      systemPrompt: {
        section: spec => (sections.push(spec), () => {}),
        context: spec => (contexts.push(spec), () => {}),
      },
    })
  },
}

const mod = await import(pathToFileURL(PLUGIN).href)
mod.apply(ctx, {})

const expected = [
  'bot_create', 'bot_set_main', 'bot_list', 'bot_message', 'bot_open', 'bot_attach',
  'group_create', 'group_post', 'group_set_mode', 'group_read',
  'workspace_memory_remember', 'workspace_memory_recall',
  'session_probe', 'ws_index_show', 'ws_index_set',
  'bot_memory_show', 'bot_memory_set',
]
const names = [...registered.keys()].sort()
const missing = expected.filter(n => !registered.has(n))
const extra = names.filter(n => !expected.includes(n))

console.log('PLUGIN=' + PLUGIN)
console.log('TOOL_COUNT=' + names.length)
console.log('TOOLS=' + names.join(','))
console.log('MISSING=' + (missing.length === 0 ? '(none)' : missing.join(',')))
console.log('EXTRA=' + (extra.length === 0 ? '(none)' : extra.join(',')))
console.log('CONTEXT_COUNT=' + contexts.length)
console.log('CONTEXT_NAMES=' + contexts.map(c => c.name).join(','))
console.log('SECTION_COUNT=' + sections.length)

// 每个工具都要有 description / parameters / output / execute，否则宿主会拒绝注册
const badShape = []
for (const [name, def] of registered) {
  if (typeof def.description !== 'string' || def.description.trim() === '') badShape.push(`${name}:description`)
  if (!def.parameters || typeof def.parameters !== 'object') badShape.push(`${name}:parameters`)
  if (!def.output || typeof def.output !== 'object') badShape.push(`${name}:output`)
  if (typeof def.execute !== 'function') badShape.push(`${name}:execute`)
}
console.log('BAD_SHAPE=' + (badShape.length === 0 ? '(none)' : badShape.join(',')))

await rm(HOME, { recursive: true, force: true })
const ok = missing.length === 0 && extra.length === 0 && contexts.length === 1 && badShape.length === 0
console.log(ok ? 'SURFACE_OK' : 'SURFACE_FAIL')
process.exitCode = ok ? 0 : 1
