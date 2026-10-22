// 权限矩阵回归测试（外部审计 issue #1 的 P1 + 收养去重）。
// 全部用临时 DSH_HOME 与临时工作区，不依赖本机路径。
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const HOME = join(tmpdir(), `dsbot-perm-home-${Date.now()}`)
const WS = join(tmpdir(), `dsbot-perm-ws-${Date.now()}`)
process.env.DSH_HOME = HOME

let pass = 0
const fails = []
function check(name, ok, detail = '') {
  ok ? pass++ : fails.push(name)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` :: ${detail}` : ''}`)
}

const baseState = () => ({
  version: 2,
  bots: {
    wb1: { id: 'wb1', name: 'wb1', role: '主 Bot', workspace: WS, main: true, sessionId: 'S_wb1' },
    n1: { id: 'n1', name: 'n1', role: '测试', workspace: WS, main: false, sessionId: 'S_n1_now', history: ['S_n1_old'] },
  },
  groups: {
    g1: {
      id: 'g1',
      name: '权限组',
      workspace: WS,
      sessionId: 'S_group1',
      members: ['n1'],
      mode: 'round-robin',
      admin: 'n1',
      createdAt: 1,
      branches: { n1: { sessionId: 'S_n1_branch', memoryFile: 'x.md', createdAt: 1 } },
    },
  },
})

async function fresh() {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(join(HOME, 'bot-ours'), { recursive: true })
  await mkdir(WS, { recursive: true })
  await writeFile(join(HOME, 'bot-ours', 'state.json'), JSON.stringify(baseState(), null, 2), 'utf8')
  const mod = await import(`${pathToFileURL(PLUGIN).href}?v=${Math.random()}`)
  const tools = new Map()
  mod.apply(
    {
      tools: { register: d => (tools.set(d.name, d), () => {}) },
      get: () => undefined,
      effect: fn => fn(),
      inject: () => {},
    },
    {},
  )
  return { tools, read: async () => JSON.parse(await readFile(join(HOME, 'bot-ours', 'state.json'), 'utf8')) }
}

/** fail() 是 throw；统一成 { ok, text }。带上 session.header.cwd 以通过工作区闸。 */
async function call(tool, args, agentId) {
  try {
    const value = await tool.execute(args, { agent: { id: agentId, session: { header: { cwd: WS } } } })
    return { ok: true, text: String(value?.text ?? '') }
  } catch (e) {
    return { ok: false, text: String(e?.message ?? e) }
  }
}

console.log('\n[1] 角色 Bot 从三个入口调 bot_set_main —— 都必须被拒')
for (const [label, sid] of [
  ['主会话', 'S_n1_now'],
  ['bot_open 旧会话（history）', 'S_n1_old'],
  ['群分支会话（branches）', 'S_n1_branch'],
]) {
  const { tools, read } = await fresh()
  const r = await call(tools.get('bot_set_main'), { bot: 'n1' }, sid)
  const st = await read()
  check(`${label}：被拒`, r.ok === false && /role Bot|Only the Main Bot/i.test(r.text), r.text.slice(0, 80))
  check(`${label}：state 未被改动`, st.bots.n1.main !== true && st.bots.wb1.main === true)
}

console.log('\n[2] 主 Bot 从自己的主会话调 —— 应放行')
{
  const { tools, read } = await fresh()
  const r = await call(tools.get('bot_set_main'), { bot: 'n1' }, 'S_wb1')
  const st = await read()
  check('放行', r.ok === true, r.text.slice(0, 80))
  check('n1 成为主位', st.bots.n1.main === true)
  check('wb1 被清位', st.bots.wb1.main === false)
}

console.log('\n[3] 用户自己的会话（不在任何 Bot 登记里）—— 不能误伤')
{
  const { tools } = await fresh()
  check('仍可调（按用户放行）', (await call(tools.get('bot_set_main'), { bot: 'n1' }, 'S_user_gui')).ok === true)
}

console.log('\n[4] 角色 Bot 从分支会话调 bot_create —— 必须被拒')
{
  const { tools } = await fresh()
  const r = await call(tools.get('bot_create'), { name: 'evil', workspace: WS }, 'S_n1_branch')
  check('被拒', r.ok === false && /Main Bot can create/i.test(r.text), r.text.slice(0, 80))
}

console.log('\n[5] 角色 Bot 从分支会话调 group_create —— 必须被拒')
{
  const { tools } = await fresh()
  const r = await call(tools.get('group_create'), { name: '绕过组', workspace: WS }, 'S_n1_branch')
  check('被拒', r.ok === false && /只有主 Bot 或用户能建群/.test(r.text), r.text.slice(0, 80))
}

console.log('\n[6] 收养去重：同一会话不能进第二个群')
{
  const { tools } = await fresh()
  const r = await call(tools.get('group_create'), { name: '收养组', workspace: WS, sessionId: 'S_group1' }, 'S_user_gui')
  check('被拒', r.ok === false && /已经是群/.test(r.text), r.text.slice(0, 100))
}

console.log('\n[7] 未被占用的会话仍可正常收养（不能一律拒）')
{
  const { tools } = await fresh()
  const r = await call(tools.get('group_create'), { name: '新群', workspace: WS, sessionId: 'S_free' }, 'S_user_gui')
  check('没被去重闸挡住', !/已经是群/.test(r.text), r.text.slice(0, 100))
}

await rm(HOME, { recursive: true, force: true })
await rm(WS, { recursive: true, force: true })
console.log(`\n结果：PASS ${pass} / FAIL ${fails.length}`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(' -', f)
  process.exitCode = 1
}
