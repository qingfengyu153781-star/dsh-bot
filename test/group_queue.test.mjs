import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HOME = await mkdtemp(join(tmpdir(), 'dsbot-queue-test-'))
process.env.DSH_HOME = HOME
const INDEX_PATH = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const mod = await import(pathToFileURL(INDEX_PATH).href + '?t=' + Date.now())

const events = new Map()
const seq = new Map()
const calls = []
function push(sid, event) {
  if (!events.has(sid)) events.set(sid, [])
  events.get(sid).push(event)
}
function nextSeq(sid) {
  const n = (seq.get(sid) ?? 0) + 1
  seq.set(sid, n)
  return n
}
const controller = {
  async create() { return { sessionId: 'created' } },
  async rename() {},
  async prompt({ sessionId, content }) {
    calls.push({ sessionId, text: content?.[0]?.text ?? '' })
    setTimeout(() => {
      push(sessionId, { seq: nextSeq(sessionId), type: 'assistant/message', time: Date.now(),
        data: { message: { content: [{ type: 'text', text: `reply:${sessionId}` }] } } })
      push(sessionId, { seq: nextSeq(sessionId), type: 'turn/end', time: Date.now() })
    }, 20)
  },
  async inspect(sessionId) { return { events: events.get(sessionId) ?? [] } },
  async resolveAgent(sessionId) {
    return { agent: { session: { append(type, data) {
      push(sessionId, { seq: nextSeq(sessionId), type, time: Date.now(), data })
    } } } }
  },
  async page() { return { records: [], hasMore: false } },
  async projections() { return {} },
}

const tools = new Map()
const ctx = {
  tools: { register(definition) { tools.set(definition.name, definition) } },
  get(name) {
    if (name === 'sessionController') return controller
    if (name === 'workspaceRegistry') {
      return { async unarchiveSession() {}, async resolveByPath() { return undefined },
        async create() { return { id: 'ws' } } }
    }
    return undefined
  },
  effect(fn) { if (typeof fn === 'function') fn() },
}
mod.apply(ctx)
const post = tools.get('group_post')
const read = tools.get('group_read')
const STATE = join(HOME, 'bot-ours', 'state.json')

async function writeState(groups) {
  await mkdir(join(HOME, 'bot-ours'), { recursive: true })
  const bots = {
    b1: { id: 'b1', sessionId: 'b1', name: 'B1', workspace: 'D:/x', workspaceId: 'ws' },
    b2: { id: 'b2', sessionId: 'b2', name: 'B2', workspace: 'D:/x', workspaceId: 'ws' },
  }
  await writeFile(STATE, JSON.stringify({ version: 2, bots, groups }, null, 2), 'utf8')
}
const g1 = { id: 'g1', name: 'G1', workspace: 'D:/x', sessionId: 'group1',
  members: ['b1', 'b2'], mode: 'round-robin', admin: 'b1' }
const g2 = { id: 'g2', name: 'G2', workspace: 'D:/x', sessionId: 'group2',
  members: ['b1', 'b2'], mode: 'round-robin', admin: 'b1' }

let pass = 0
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  [PASS] ' + name) }
  else { console.log('  [FAIL] ' + name + (detail ? '  —— ' + detail : '')); process.exitCode = 1 }
}

console.log('=== A. 同群并发：队列串行 + 两轮日志都不丢 ===')
await writeState({ g1 })
const [ra, rb] = await Promise.all([
  post.execute({ group: 'G1', text: '甲' }),
  post.execute({ group: 'G1', text: '乙' }),
])
const stA = JSON.parse(await readFile(STATE, 'utf8'))
const logA = stA.groups.g1.log
ok('两轮都在（log=6）', logA.length === 6, `log=${logA.length}`)
ok('seq 连续 1..6', JSON.stringify(logA.map(x => x.seq)) === JSON.stringify([1, 2, 3, 4, 5, 6]),
  JSON.stringify(logA.map(x => x.seq)))
ok('两条用户消息都保留', JSON.stringify(logA.filter(x => x.role === 'user').map(x => x.text).sort()) === JSON.stringify(['乙', '甲'].sort()),
  JSON.stringify(logA.filter(x => x.role === 'user').map(x => x.text)))
ok('rounds=2', stA.groups.g1.rounds === 2, `rounds=${stA.groups.g1.rounds}`)
ok('群会话可见 6 条（2 用户 + 4 发言）',
  (events.get('group1') ?? []).filter(e => e.type === 'user/message').length === 6,
  `${(events.get('group1') ?? []).filter(e => e.type === 'user/message').length}`)
ok('返回带本轮结果', String(ra.text).includes('本轮结束') && String(rb.text).includes('本轮结束'))

console.log('=== B. 跨群并发：短事务不互相覆盖 ===')
await writeState({ g1, g2 })
await Promise.all([
  post.execute({ group: 'G1', text: '甲' }),
  post.execute({ group: 'G2', text: '乙' }),
])
const stB = JSON.parse(await readFile(STATE, 'utf8'))
const l1 = stB.groups.g1?.log ?? []
const l2 = stB.groups.g2?.log ?? []
ok('G1 log=3', l1.length === 3, `g1=${l1.length}`)
ok('G2 log=3', l2.length === 3, `g2=${l2.length}`)
ok('G1 rounds=1 / G2 rounds=1', stB.groups.g1?.rounds === 1 && stB.groups.g2?.rounds === 1)

console.log('=== C. group_read 以会话为准（log 落后也不藏消息）===')
// 模拟压测中的丢日志：只留第一条，会话里仍有完整两轮
stB.groups.g1.log = [(stB.groups.g1.log ?? [])[0]].filter(Boolean)
await writeFile(STATE, JSON.stringify(stB, null, 2), 'utf8')
const rr = await read.execute({ group: 'G1', limit: 20 })
ok('读了会话，包含两条用户消息', String(rr.text).includes('甲') && String(rr.text).includes('乙'), String(rr.text).slice(0, 120))
ok('提示派生日志与会话不一致', String(rr.text).includes('派生 group.log') || String(rr.text).includes('会话可见'))

console.log(`\n${pass} 项通过`)
