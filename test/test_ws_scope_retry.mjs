// 审计 issue #1 第 3、4 条的回归测试：工作区白名单 + 成员会话被占时的重试语义。
// 全部用临时 DSH_HOME 与临时工作区，不依赖本机路径。
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const HOME = join(tmpdir(), `dsbot-scope-home-${Date.now()}`)
const WS = join(tmpdir(), `dsbot-scope-ws-${Date.now()}`)
process.env.DSH_HOME = HOME

let pass = 0
const fails = []
function check(name, ok, detail = '') {
  ok ? pass++ : fails.push(name)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` :: ${detail}` : ''}`)
}

const state0 = () => ({
  version: 2,
  bots: {
    wb1: { id: 'wb1', name: 'wb1', role: '主 Bot', workspace: WS, main: true, sessionId: 'S_wb1' },
    n1: { id: 'n1', name: 'n1', role: '测试', workspace: WS, main: false, sessionId: 'S_n1' },
  },
  groups: {
    g1: { id: 'g1', name: '占用组', workspace: WS, sessionId: 'S_g1', members: ['n1'], mode: 'round-robin', admin: 'n1', createdAt: 1, branches: {} },
  },
})

/** controller 桩：prompt 默认报「已被占用」；inspect 回空事件。 */
function stubController() {
  return {
    prompt: async () => {
      throw new Error('session "S_x" is already owned by an active turn')
    },
    inspect: async () => ({ events: [], meta: { cwd: WS } }),
    resolveAgent: async () => {
      throw new Error('no agent in stub')
    },
    rename: async () => {},
    create: async () => ({ sessionId: 'S_new' }),
  }
}

async function load(config = {}, controller = stubController()) {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(join(HOME, 'bot-ours'), { recursive: true })
  await mkdir(WS, { recursive: true })
  await writeFile(join(HOME, 'bot-ours', 'state.json'), JSON.stringify(state0(), null, 2), 'utf8')
  const mod = await import(`${pathToFileURL(PLUGIN).href}?v=${Math.random()}`)
  const tools = new Map()
  mod.apply(
    {
      tools: { register: d => (tools.set(d.name, d), () => {}) },
      get: name => (name === 'sessionController' ? controller : undefined),
      effect: fn => fn(),
      inject: () => {},
    },
    config,
  )
  return {
    tools,
    read: async () => JSON.parse(await readFile(join(HOME, 'bot-ours', 'state.json'), 'utf8')),
  }
}

const asSession = (cwd = WS) => ({ agent: { id: 'S_user', session: { header: { cwd } } } })
async function call(tool, args, exec = asSession()) {
  try {
    return { ok: true, text: String((await tool.execute(args, exec))?.text ?? '') }
  } catch (e) {
    return { ok: false, text: String(e?.message ?? e) }
  }
}

console.log('\n[1] 工作区闸：未登记且不在会话 cwd 下的路径被拒')
{
  const { tools } = await load()
  const outside = join(tmpdir(), `dsbot-outside-${Date.now()}`, 'nested')
  const r = await call(tools.get('workspace_memory_remember'), { workspace: outside, text: 'x' })
  check('被拒', r.ok === false && /不在已登记工作区|allowUnregisteredWorkspace/.test(r.text), r.text.slice(0, 120))
  const r2 = await call(tools.get('ws_index_set'), { workspace: join(tmpdir(), `dsbot-sys-${Date.now()}`), content: 'x' })
  check('ws_index_set 同样被拒', r2.ok === false && /不在已登记工作区/.test(r2.text), r2.text.slice(0, 100))
}

console.log('\n[2] 工作区闸：本会话 cwd 及其子目录放行')
{
  const { tools } = await load()
  const sub = join(WS, 'sub')
  await mkdir(sub, { recursive: true })
  const r = await call(tools.get('workspace_memory_remember'), { workspace: sub, text: '子目录也放行' })
  check('子目录放行', r.ok === true, r.text.slice(0, 100))
}

console.log('\n[3] 工作区闸：显式开 allowUnregisteredWorkspace 才越界')
{
  const { tools } = await load({ allowUnregisteredWorkspace: true })
  const r = await call(tools.get('workspace_memory_remember'), { workspace: join(tmpdir(), `dsbot-outside-allowed-${Date.now()}`), text: 'y' })
  check('配置后放行', r.ok === true, r.text.slice(0, 100))
}

console.log('\n[4] 群发言：成员会话被占 → 标注「可重试」并尝试补投')
{
  const { tools } = await load()
  const r = await call(tools.get('group_post'), { group: '占用组', text: '随便说一句' })
  check('不抛异常（整轮不再失败）', r.ok === true, r.text.slice(0, 120))
  check('明确标出可重试', /可重试/.test(r.text), r.text.slice(0, 200))
  check('返回里带补投结论', /补投|仍被占用/.test(r.text), r.text.slice(0, 200))
}

console.log('\n[5] 群发言：非占用类错误 → 判「永久失败」，不补投')
{
  const controller = stubController()
  controller.prompt = async () => {
    throw new Error('model refused: quota exceeded')
  }
  const { tools } = await load({}, controller)
  const r = await call(tools.get('group_post'), { group: '占用组', text: '随便说一句' })
  check('标为永久失败', /永久失败/.test(r.text), r.text.slice(0, 200))
  check('不做补投', !/已补投/.test(r.text), r.text.slice(0, 200))
}

await rm(HOME, { recursive: true, force: true })
await rm(WS, { recursive: true, force: true })
console.log(`\n结果：PASS ${pass} / FAIL ${fails.length}`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(' -', f)
  process.exitCode = 1
}
