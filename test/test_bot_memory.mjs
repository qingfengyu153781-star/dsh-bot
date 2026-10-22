// Bot 专属记忆（bot-memory）回归测试：不同 Bot 注入不同记忆，用户会话拿不到。
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const HOME = join(tmpdir(), `dsbot-botmem-home-${Date.now()}`)
const WS = join(tmpdir(), `dsbot-botmem-ws-${Date.now()}`)
process.env.DSH_HOME = HOME

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fails.push(name)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` :: ${detail}` : ''}`)
}

const state0 = () => ({
  version: 2,
  bots: {
    wb1: { id: 'wb1', name: 'wb1', role: '主 Bot', workspace: WS, main: true, sessionId: 'S_wb1', instructions: '你是主 Bot，负责拆活与验收。' },
    scout: { id: 'scout', name: 'scout', role: '侦察', workspace: WS, main: false, sessionId: 'S_scout_now', history: ['S_scout_old'], instructions: '你只做侦察，不写实现。' },
    impl: { id: 'impl', name: 'impl', role: '实施', workspace: WS, main: false, sessionId: 'S_impl' },
  },
  groups: {
    g1: { id: 'g1', name: '评审组', workspace: WS, sessionId: 'S_g1', members: ['scout'], mode: 'round-robin', admin: 'scout', createdAt: 1, branches: { scout: { sessionId: 'S_scout_branch', memoryFile: 'x.md', createdAt: 1 } } },
  },
})

function makeCtx() {
  const tools = new Map()
  const contexts = []
  const ctx = {
    tools: { register: d => (tools.set(d.name, d), () => tools.delete(d.name)) },
    get: () => undefined,
    effect: fn => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined) },
    inject: (deps, cb) => cb({ systemPrompt: { section: () => () => {}, context: s => (contexts.push(s), () => {}) } }),
  }
  return { ctx, tools, contexts }
}

async function load(config = {}) {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(join(HOME, 'bot-ours'), { recursive: true })
  await mkdir(WS, { recursive: true })
  await writeFile(join(HOME, 'bot-ours', 'state.json'), JSON.stringify(state0(), null, 2), 'utf8')
  const mod = await import(`${pathToFileURL(PLUGIN).href}?v=${Math.random()}`)
  const { ctx, tools, contexts } = makeCtx()
  mod.apply(ctx, config)
  return { mod, tools, contexts }
}

const asm = (sessionId, cwd = WS) => ({ agent: { id: sessionId, session: { header: { cwd } } } })

// 预置：两个 Bot 各写一份不同的专属记忆
await mkdir(join(WS, '.dsh-bot', 'bots'), { recursive: true })
await writeFile(join(WS, '.dsh-bot', 'bots', 'scout.md'), '# scout\n\n- 侦察记录：发现 A 模块有内存泄漏\n', 'utf8')
await writeFile(join(WS, '.dsh-bot', 'bots', 'impl.md'), '# impl\n\n- 实施记录：已修复 B 模块的空指针\n', 'utf8')

console.log('\n[1] 不同 Bot 拿到不同记忆')
{
  const { contexts } = await load()
  const text = contexts[0].text.bind(contexts[0])
  const scout = text(asm('S_scout_now'))
  const impl = text(asm('S_impl'))
  const user = text(asm('S_user_gui'))
  check('scout 看到自己的记忆', scout.includes('A 模块有内存泄漏'), scout.slice(0, 120))
  check('scout 看不到 impl 的记忆', !scout.includes('B 模块的空指针'))
  check('impl 看到自己的记忆', impl.includes('B 模块的空指针'), impl.slice(0, 120))
  check('impl 看不到 scout 的记忆', !impl.includes('A 模块有内存泄漏'))
  check('用户会话没有 Bot 块', !user.includes('<!-- bot-memory:v1 -->'), user.slice(0, 120))
  check('用户会话拿不到任何 Bot 记忆', !user.includes('A 模块有内存泄漏') && !user.includes('B 模块的空指针'))
}

console.log('\n[2] 人设与常驻指令也注入')
{
  const { contexts } = await load()
  const scout = contexts[0].text(asm('S_scout_now'))
  check('带身份行', scout.includes('侦察'), scout.slice(0, 200))
  check('带 instructions', scout.includes('你只做侦察，不写实现。'))
  check('主 Bot 标记', contexts[0].text(asm('S_wb1')).includes('主 Bot'))
}

console.log('\n[3] 归属判定与 callerBot 同口径（history / 群分支会话）')
{
  const { contexts } = await load()
  check('bot_open 旧会话也归属 scout', contexts[0].text(asm('S_scout_old')).includes('A 模块有内存泄漏'))
  check('群分支会话也归属 scout', contexts[0].text(asm('S_scout_branch')).includes('A 模块有内存泄漏'))
}

console.log('\n[4] 没有工作区索引时，Bot 块仍然注入')
{
  const { contexts } = await load()
  const scout = contexts[0].text(asm('S_scout_now'))
  check('无 ws-index 文件时仍有 bot 块', scout.includes('<!-- bot-memory:v1 -->'))
  check('且不含 ws-index 块', !scout.includes('<!-- ws-index:v1 -->'))
}

console.log('\n[5] 两者共存：工作区块 + Bot 块')
{
  await writeFile(join(WS, '.dsh-bot', 'WS_INDEX.md'), '# 工作区索引\n\n- 共享入口\n', 'utf8')
  const { contexts } = await load()
  const scout = contexts[0].text(asm('S_scout_now'))
  check('同时含两个块', scout.includes('<!-- ws-index:v1 -->') && scout.includes('<!-- bot-memory:v1 -->'))
  check('工作区块在前', scout.indexOf('ws-index:v1') < scout.indexOf('bot-memory:v1'))
}

console.log('\n[6] bot_memory_set / bot_memory_show')
{
  const { tools } = await load()
  const set = tools.get('bot_memory_set')
  const show = tools.get('bot_memory_show')
  check('两个工具都注册了', set !== undefined && show !== undefined)
  const r1 = await set.execute({ bot: 'impl', content: '- 新记录：C 模块重构完成' }, { agent: { id: 'S_wb1', session: { header: { cwd: WS } } } })
  check('写入成功', String(r1.text).includes('已写入'), String(r1.text))
  check('提示只对 impl 可见', String(r1.text).includes('只有 **impl**'), String(r1.text))
  const body = await readFile(join(WS, '.dsh-bot', 'bots', 'impl.md'), 'utf8')
  check('文件已落盘', body.includes('C 模块重构完成'), body)
  const r2 = await show.execute({ bot: 'scout' }, { agent: { id: 'S_user_gui', session: { header: { cwd: WS } } } })
  check('show 回显 scout 的块', String(r2.text).includes('A 模块有内存泄漏'), String(r2.text).slice(0, 120))
  // fail() 是 throw；用户会话省略 bot 时必须被拒（拿不到别人的记忆）
  let r3text = ''
  try {
    const r3 = await show.execute({}, { agent: { id: 'S_user_gui', session: { header: { cwd: WS } } } })
    r3text = String(r3.text)
  } catch (e) {
    r3text = String(e?.message ?? e)
  }
  check('用户会话省略 bot 时被拒', /不属于任何 Bot/.test(r3text), r3text.slice(0, 100))
}

console.log('\n[7] 配置：关掉就不注入 Bot 块')
{
  const { contexts } = await load({ botMemoryEnabled: false })
  const scout = contexts[0].text(asm('S_scout_now'))
  check('botMemoryEnabled=false 时不注入', !scout.includes('<!-- bot-memory:v1 -->'))
}

console.log('\n[8] 坏输入不抛')
{
  const { contexts } = await load()
  let threw = null
  let out = 'x'
  try { out = contexts[0].text(undefined) } catch (e) { threw = e }
  check('undefined 不抛', threw === null && out === '')
  try { out = contexts[0].text({ agent: {} }) } catch (e) { threw = e }
  check('空 agent 不抛', threw === null)
  await rm(join(HOME, 'bot-ours', 'state.json'), { force: true })
  try { out = contexts[0].text(asm('S_scout_now')) } catch (e) { threw = e }
  check('state.json 消失也不抛', threw === null, String(threw))
}

await rm(HOME, { recursive: true, force: true })
await rm(WS, { recursive: true, force: true })
console.log(`\n结果：PASS ${pass} / FAIL ${fails.length}`)
if (fails.length > 0) { console.log('失败项：'); for (const f of fails) console.log(' -', f); process.exitCode = 1 }
