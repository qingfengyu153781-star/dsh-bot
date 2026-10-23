/**
 * @local/dsh-bot —— 自研 Bot 宿主插件（v0.1）
 *
 * 设计（对应用户要求）：
 *  1. 主 Bot 按**工作区**分类：每个 Bot 记录自己的 workspace，列表按 workspace 分组；
 *  2. 每个工作区**单独记忆**：记忆文件放在 `<workspace>/.dsh-bot/memory/`，互不串味；
 *  3. 群聊＝**真实 DSH 会话**：群聊就是一个 Session，因此天然和普通会话一样显示在会话列表里；
 *  4. 能力与 ds bot 对齐：create/list/message/group/memory 七件套工具。
 *
 * 数据：
 *   ~/.dsh/bot-ours/state.json        Bot 与群的登记（派生缓存，会话日志才是真相源）
 *   <workspace>/.dsh-bot/memory/      该工作区专属记忆
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { installDispatcher } from './dispatcher.js'

export const name = '@local/dsh-bot'
export const inject = ['tools']

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const STATE_DIR = join(HOME, 'bot-ours')
const STATE_PATH = join(STATE_DIR, 'state.json')

const EMPTY_STATE = { version: 2, bots: {}, groups: {} }

// ── 并发控制（2026-10-18 生产群压测修复）──────────────────────────────
// 1) 同一群的 group_post 必须串行（排队）：实测两轮并发会互相穿插、
//    成员收到两份「本轮上下文」，且 state.json 整对象覆盖导致一轮 group.log 丢失。
// 2) 状态写入走短事务串行：group_post 每落一条就 load→append→save，
//    不再把开轮时的旧快照保存到轮末（跨群并发也不会互相覆盖）。
const GROUP_QUEUES = new Map()
function serializeGroup(key, task) {
  const prev = GROUP_QUEUES.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  GROUP_QUEUES.set(key, tail)
  tail.finally(() => {
    if (GROUP_QUEUES.get(key) === tail) GROUP_QUEUES.delete(key)
  })
  return run
}

let STATE_CHAIN = Promise.resolve()
function serializeState(task) {
  const run = STATE_CHAIN.then(task, task)
  STATE_CHAIN = run.then(() => undefined, () => undefined)
  return run
}

// ── 状态读写：内存缓存 + 合并写（高并发关键路径）──────────────────────
// 旧实现每条发言都 load→save 整份 state.json；成员一多就是 I/O 风暴，
// 并发轮次互相拖慢。现在：
//   · 读：进程内缓存，文件 mtime 变了才重新解析（外部手工改仍能生效）；
//   · 写：150ms 合并写一次（只写最新快照），落盘前不阻塞轮次。
let CACHED_STATE = null
let CACHED_MTIME = 0
let PENDING_SAVE = null
let SAVE_TIMER = null

async function loadStateCached() {
  try {
    const info = await stat(STATE_PATH)
    if (CACHED_STATE !== null && info.mtimeMs === CACHED_MTIME) return CACHED_STATE
    CACHED_MTIME = info.mtimeMs
  } catch {
    // 文件还不存在：照常解析（会在下面回落成空状态）
  }
  const fresh = await loadState()
  CACHED_STATE = fresh
  return fresh
}

function saveStateSoon(state) {
  CACHED_STATE = state
  PENDING_SAVE = state
  if (SAVE_TIMER !== null) return
  SAVE_TIMER = setTimeout(() => {
    SAVE_TIMER = null
    const snapshot = PENDING_SAVE
    PENDING_SAVE = null
    if (snapshot === null) return
    saveState(snapshot)
      .then(async () => {
        try {
          CACHED_MTIME = (await stat(STATE_PATH)).mtimeMs
        } catch {
          CACHED_MTIME = 0
        }
      })
      .catch(() => {})
  }, 150)
}

/** 需要"写完再返回"的场合（例如工具返回前）显式刷盘。 */
async function flushStateWrites() {
  if (SAVE_TIMER !== null) {
    clearTimeout(SAVE_TIMER)
    SAVE_TIMER = null
  }
  const snapshot = PENDING_SAVE
  PENDING_SAVE = null
  if (snapshot === null) return
  await saveState(snapshot)
  try {
    CACHED_MTIME = (await stat(STATE_PATH)).mtimeMs
  } catch {
    CACHED_MTIME = 0
  }
}

/** 状态短事务：在锁内 读缓存 → mutate → 合并写。 */
async function mutateState(mutator) {
  return serializeState(async () => {
    const state = await loadStateCached()
    const value = await mutator(state)
    saveStateSoon(state)
    return value
  })
}


/**
 * 读取状态并做版本迁移（P2-1）：
 *   1 → 2：新增 groups（群聊登记），旧文件没有该字段时补空对象，其余字段原样保留。
 * 迁移是纯内存归一，不在此处写盘；下一次 saveState 会落成 version=2。
 */
/**
 * 读取状态 + 归一化（防绕过，**不删任何登记**）：
 *  - 每个工作区最多一个 main：同区出现多个 main 时保留最先出现的，其余清掉；
 *  - 缺 sessionId / workspaceId / id 的残缺登记只**标记**出来（交给 bot_list 报告与人工修），
 *    绝不在这里删除——删登记等于删用户的 Bot。
 * 归一化只在内存里，下一次 saveState 才落盘；修过什么记在 __repairs 里。
 */
async function loadState() {
  try {
    const text = await readFile(STATE_PATH, 'utf8')
    const parsed = JSON.parse(text)
    const bots = parsed && typeof parsed.bots === 'object' && parsed.bots !== null ? parsed.bots : {}
    const groups = parsed && typeof parsed.groups === 'object' && parsed.groups !== null ? parsed.groups : {}
    const version = parsed && typeof parsed.version === 'number' ? parsed.version : 1
    const repairs = []
    const seenMain = new Set()
    for (const [key, bot] of Object.entries(bots)) {
      if (bot === null || typeof bot !== 'object') {
        repairs.push(`登记 ${key} 不是对象，已忽略（未删除）`)
        continue
      }
      if (!bot.id) bot.id = bot.sessionId ?? key
      if (typeof bot.sessionId !== 'string' || bot.sessionId.trim() === '') {
        repairs.push(`登记 ${bot.name ?? key} 缺 sessionId（未删除）`)
      }
      if (!bot.workspaceId) {
        repairs.push(`登记 ${bot.name ?? key} 缺 workspaceId（未删除）`)
      }
      if (bot.main === true) {
        const ws = String(bot.workspace ?? '').toLowerCase()
        if (seenMain.has(ws)) {
          bot.main = false
          repairs.push(`清掉同区多余主位：${bot.name ?? key}`)
        } else {
          seenMain.add(ws)
        }
      }
    }
    return { version: Math.max(version, 2), bots, groups, repairs }
  } catch {
    return { ...EMPTY_STATE, bots: {}, groups: {}, repairs: [] }
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true })
  // repairs 只是本次读取的诊断信息，不写进文件（否则会越积越多，还会被当成数据读回来）。
  const { repairs, __repairs, ...persisted } = state
  await writeFile(STATE_PATH, JSON.stringify({ ...persisted, version: 2 }, null, 2) + '\n', 'utf8')
}

function memoryDir(workspace) {
  return join(workspace, '.dsh-bot', 'memory')
}


function ok(text) {
  // execute() 的返回值必须就是 output.schema 声明的那个值（这里是 { text }），
  // 展示内容由 output.render(args, value) 负责；再包一层 { value, content } 会通不过校验。
  return { text }
}

function fail(text) {
  throw new Error(text)
}

/**
 * 路径里的控制字符闸（实测：`<盘符>:\project` 被写成单反斜杠后，
 * `\a` / `\b` 变成控制字符，建目录/登记都落到了错的地方，现象是"路径对不上"）。
 * 这里直接拦住并给出可照抄的正确写法，避免悄悄地建出怪目录。
 */
function assertUsablePath(value, label) {
  const text = String(value ?? '')
  const bad = text.match(/[\u0000-\u001F]/u)
  if (bad !== null) {
    const code = bad[0].codePointAt(0).toString(16).padStart(4, '0')
    fail(
      `${label} 里含控制字符 U+${code.toUpperCase()}（通常是 JSON 里把反斜杠写成了单个 \\，` +
        `例如 "<盘符>:\\project" 会被解析成 \\a、\\b）。请写成 "<盘符>:\\\\project" 或改用 /。`,
    )
  }
  return text
}

function findBot(state, key) {
  if (!key) return undefined
  const byName = Object.values(state.bots).find(bot => bot.name === key)
  return byName ?? state.bots[key]}

/**
 * 名字归一化：把「人写的名字」解析成「真实的 Bot」。
 *
 * 动机：2026-10-23 实测 53 次消息通道故障，全部是**名字形式不对**而非名字真错：
 *   [主] 灵枢文档下载…  ·  缺陷拆解-3 **C「做完了…」**  ·  裁决-3  ·  【审查-2B · v4 …】
 * findBot 是严格相等，差一个字就 Unknown Bot。
 *
 * 返回 { bot, how, tried }：
 *   bot   找到的 Bot 对象（找不到为 undefined）
 *   how   用哪种方式命中的（exact / id / strip-prefix / strip-quote / prefix / contains）
 *   tried 尝试过的所有归一化形式（报错时用来提示）
 *
 * ⚠ 精确匹配永远第一优先，不改变任何现有成功路径。
 * ⚠ 包含匹配只在唯一候选时采纳；有歧义就返回 undefined 并给候选，绝不瞎猜。
 */
function resolveBotKey(state, key) {
  const tried = []
  if (key === undefined || key === null) return { bot: undefined, how: 'none', tried }
  const raw = String(key)
  if (raw.trim() === '') return { bot: undefined, how: 'none', tried }

  const all = Object.values(state.bots)

  // ① 精确名 / 精确 id —— 原逻辑，最高优先
  const exact = findBot(state, raw)
  if (exact) return { bot: exact, how: 'exact', tried }

  // 归一化候选（按"信息损失从小到大"排列）
  const forms = []
  const add = (v) => { const t = String(v).trim(); if (t && !forms.includes(t)) forms.push(t) }

  // 全角 → 半角（含全角空格 U+3000）
  const half = raw.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  add(half)

  // ② 去前缀：[主] [群] [Bot] 【…】 (…)
  const stripPrefix = half
    .replace(/^\s*[\[【(（][^\]】)）]{0,20}[\]】)）]\s*/, '')
    .replace(/^\s*(主|群|Bot|bot|MAIN|main)\s*[:：]\s*/, '')
  add(stripPrefix)

  // ③ 去引号 / 反引号 / 多余空白
  const stripQuote = stripPrefix.replace(/[\s"'\u0060]+/g, ' ').replace(/^\s+|\s+$/g, '')
  add(stripQuote)

  // 逐个试精确匹配
  for (const f of forms) {
    const hit = findBot(state, f)
    if (hit) return { bot: hit, how: 'normalized', tried: [...tried, f] }
    tried.push(f)
  }

  // ④ 前缀匹配：key 是某个 Bot 名的前缀（如 core-3 → team-core-3）
  //    取最长的唯一前缀，避免短前缀同时匹配 team-core-1/2/3。
  const pool = [raw, ...forms].map((v) => v.trim()).filter(Boolean)
  for (const f of pool) {
    if (f.length < 2) continue
    const hits = all.filter((b) => b.name.startsWith(f) || f.startsWith(b.name))
    if (hits.length === 1) return { bot: hits[0], how: 'prefix', tried }
    if (hits.length > 1) {
      // 有歧义：如果其中一个是另一个的精确扩展，不猜，直接返回候选
      return { bot: undefined, how: 'ambiguous', tried, candidates: hits.map((b) => b.name) }
    }
  }

  // ⑤ 包含匹配：Bot 名包含 key（唯一才采纳）
  for (const f of pool) {
    if (f.length < 3) continue
    const hits = all.filter((b) => b.name.includes(f))
    if (hits.length === 1) return { bot: hits[0], how: 'contains', tried }
    if (hits.length > 1) return { bot: undefined, how: 'ambiguous', tried, candidates: hits.map((b) => b.name) }
  }

  // 全失败：给出最接近的候选（按公共前缀长度排序）
  const near = all
    .map((b) => {
      let n = 0
      const a = raw.trim()
      while (n < Math.min(a.length, b.name.length) && a[n] === b.name[n]) n++
      return { name: b.name, score: n }
    })
    .filter((x) => x.score >= 2)
    .sort((x, y) => y.score - x.score)
    .slice(0, 5)
    .map((x) => x.name)

  return { bot: undefined, how: 'not-found', tried, candidates: near }
}

function findGroup(state, key) {
  if (!key) return undefined
  const byName = Object.values(state.groups).find(group => group.name === key)
  return byName ?? state.groups[key]
}

/**
 * 认「这条会话属于哪个 Bot」。
 *
 * ⚠ 2026-10-22 修 P1（外部审计 issue #1 实测）：旧实现只比对 `bot.sessionId`，
 * 于是凡是不等于**当前主会话**的会话都被当成「用户」，main 闸门被绕过。两个真实入口：
 *   ① 群成员分支会话（`[群] 群名 · Bot名`）：角色 Bot 从那里调 bot_set_main 自封主位成功；
 *   ② `bot_open` 之后的旧会话：旧 id 进了 `bot.history`，但旧实现不查 history —— 不需要群也能绕过。
 * 现在三个来源全查（都是**已有数据**，不新增状态）：
 *   bot.sessionId（当前主会话）· bot.history[]（开新对话后的旧会话）· group.branches[botId]（群分支会话）。
 *
 * 为什么不做「认不出就按角色 Bot 拒绝」：用户自己的会话同样不在任何 Bot 登记里，
 * 默认拒绝会把用户一起挡掉（bot_create / bot_set_main 从用户会话就再也调不通）。
 */
function callerBot(state, exec) {
  const sessionId = exec && exec.agent ? exec.agent.id : undefined
  if (!sessionId) return undefined
  const bots = Object.values(state.bots ?? {})
  const direct = bots.find(bot => bot.sessionId === sessionId)
  if (direct !== undefined) return direct
  const viaHistory = bots.find(bot => Array.isArray(bot.history) && bot.history.includes(sessionId))
  if (viaHistory !== undefined) return viaHistory
  for (const group of Object.values(state.groups ?? {})) {
    const branches = group && group.branches
    if (branches === null || typeof branches !== 'object') continue
    for (const [botId, record] of Object.entries(branches)) {
      if (record && record.sessionId === sessionId) {
        const owner = state.bots?.[botId] ?? bots.find(bot => bot.id === botId)
        if (owner !== undefined) return owner
      }
    }
  }
  return undefined
}

function briefBot(bot) {
  const bits = [bot.main === true ? `[主] ${bot.name}` : bot.name]
  if (bot.role) bits.push(`(${bot.role})`)
  bits.push(`workspace=${bot.workspace}`)
  if (bot.sessionId) bits.push(`session=${bot.sessionId}`)
  return bits.join(' ')
}

// ── 工作区索引记忆（WS_INDEX）：每轮自动注入 ─────────────────────────────
// 需求（用户 2026-10-22）：给一个工作区设定一份「索引记忆文件」，该工作区的**每个会话
// 每一轮**都自动带上它，不必每次让模型自己去翻。
//
// 四条硬约束，每条都对应一个会真实发生的坏结果：
//   1) 走 `systemPrompt.context`（每轮装配时取一次），不用 `section`（注册时内容就固定，
//      改了文件下一轮不会变）。arbiter 的实测注释写明：context 的 `text(ctx)` 是**同步**的。
//   2) `text()` 必须**永不抛**：它在每个会话的每一步装配里都跑，抛一次就毁掉本工作区所有会话。
//      所以文件缺失 / 读失败 / 编码坏 / 渲染异常，一律返回空串 + 留一条日志。
//   3) 只注入「索引 + 指向原文的路径」，正文按需读。索引涨到 1 MB 也不挤上下文（有字节上限）。
//   4) 索引文件**不叫** AGENTS.md / CLAUDE.md：那两个名字由宿主自己的 agent-instructions 注入，
//      插件再注入一遍就是同一段话出现两遍（而且改一处另一处不会同步）。
const WS_INDEX_MARKER_OPEN = '<!-- ws-index:v1 -->'
const WS_INDEX_MARKER_CLOSE = '<!-- /ws-index:v1 -->'
const WS_INDEX_DEFAULT_REL = join('.dsh-bot', 'WS_INDEX.md')
const WS_INDEX_DEFAULT_MAX_BYTES = 8192
const WS_INDEX_MAX_WALK = 12
const WS_INDEX_HOST_OWNED = new Set(['agents.md', 'claude.md'])
/** 文件路径 -> { mtimeMs, size, body }；只缓存正文，渲染按会话现拼（很便宜）。 */
const WS_INDEX_CACHE = new Map()

function wsIndexNote(line) {
  try {
    const file = join(STATE_DIR, 'ws-index.log')
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size > 64 * 1024) writeFileSync(file, '', 'utf8') // 有界：不让日志长成第二个数据库
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志写不进去也绝不能影响注入
  }
}

/** 会话工作目录：优先 session.header.cwd（宿主建会话时写入的真相），其次 agent.cwd。 */
function wsIndexAgentCwd(agent) {
  if (agent === undefined || agent === null) return ''
  const session = agent.session ?? (typeof agent.getSession === 'function' ? agent.getSession() : undefined)
  const fromHeader = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
  if (fromHeader !== '') return fromHeader
  return typeof agent.cwd === 'string' ? agent.cwd : ''
}

function wsIndexCwdOfAssembly(assemblyCtx) {
  return wsIndexAgentCwd(assemblyCtx && assemblyCtx.agent)
}

/**
 * 从 cwd 向上找**最近**的一份索引文件。
 * 这样「工作区子目录里开的会话」也会归属到所在工作区，而不是各写一份。
 */
function wsIndexLocate(cwd, rel) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  if (isAbsolute(rel)) {
    try {
      return statSync(rel).isFile() ? rel : undefined
    } catch {
      return undefined
    }
  }
  let dir = resolve(cwd)
  for (let step = 0; step < WS_INDEX_MAX_WALK; step += 1) {
    const candidate = join(dir, rel)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 这一层没有，继续向上
    }
    const parent = dirname(dir)
    if (parent === dir || parent === '') break
    dir = parent
  }
  return undefined
}

/** 同步读 + 按 (mtime, size) 缓存：每轮只 stat 一次，内容没变就不重读。 */
function wsIndexRead(file) {
  let info
  try {
    info = statSync(file)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!info.isFile()) return { ok: false, reason: 'not-a-file' }
  const cached = WS_INDEX_CACHE.get(file)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error?.message ?? error}` }
  }
  const entry = {
    ok: true,
    file,
    mtimeMs: info.mtimeMs,
    size: info.size,
    body: raw.replace(/^\uFEFF/u, '').replace(/\r\n/g, '\n').trim(),
  }
  WS_INDEX_CACHE.set(file, entry)
  if (WS_INDEX_CACHE.size > 64) {
    const first = WS_INDEX_CACHE.keys().next().value
    if (first !== undefined) WS_INDEX_CACHE.delete(first)
  }
  return entry
}

function wsIndexTruncate(body, maxBytes) {
  const total = Buffer.byteLength(body, 'utf8')
  if (total <= maxBytes) return { text: body, truncated: false, dropped: 0 }
  const cut = Buffer.from(body, 'utf8')
    .subarray(0, Math.max(0, maxBytes))
    .toString('utf8')
    .replace(/\uFFFD+$/u, '') // 别把多字节字符截成半个
  return { text: cut, truncated: true, dropped: total - Buffer.byteLength(cut, 'utf8') }
}

function wsIndexRender(entry, cwd, maxBytes) {
  const { text, truncated, dropped } = wsIndexTruncate(entry.body, maxBytes)
  const kb = (entry.size / 1024).toFixed(1)
  const when = new Date(entry.mtimeMs).toISOString().replace(/\.\d{3}Z$/u, 'Z')
  const lines = [
    WS_INDEX_MARKER_OPEN,
    '## 工作区索引记忆（自动注入 · 每轮）',
    '',
    `- 工作区：${cwd}`,
    `- 索引文件：${entry.file}（${kb} KB，更新于 ${when}）`,
    '- 口径：这是**索引与入口**，不是全文；要细节按下面的路径去读原文，不要凭印象补。',
    '',
    text,
  ]
  if (truncated) {
    lines.push('', `…（超过注入上限 ${maxBytes} 字节，已截断 ${dropped} 字节；完整内容请读上面那个文件）`)
  }
  lines.push(WS_INDEX_MARKER_CLOSE)
  return lines.join('\n')
}


// ── Bot 专属记忆（bot-memory）：按会话归属注入 ───────────────────────────
// 需求（用户 2026-10-22）：不同的 Bot 要能拿到**不同的**记忆，而不是全工作区共用一份。
//
// 与 ws-index 的分工：
//   ws-index    = 工作区级，该工作区**所有会话**都注入（共享的事实与入口）
//   bot-memory  = Bot 级，只有**属于某个 Bot 的会话**才注入（人设 + 该 Bot 的专属记忆）
// 两者可同时出现；Bot 会话里是「工作区块 + 自己那块」，用户会话里只有工作区块。
//
// 归属判定与 callerBot() 同口径（主会话 / history 旧会话 / 群分支会话），
// 但这里必须**同步**（systemPrompt.context 的 text() 不能 await），所以单独走一次
// 同步读 state.json，并按 mtime 缓存。
const BOT_MEMORY_MARKER_OPEN = '<!-- bot-memory:v1 -->'
const BOT_MEMORY_MARKER_CLOSE = '<!-- /bot-memory:v1 -->'
const BOT_MEMORY_DEFAULT_REL = join('.dsh-bot', 'bots')
const BOT_MEMORY_DEFAULT_MAX_BYTES = 4096
const NEWLINE2 = String.fromCharCode(10) + String.fromCharCode(10)

let BOT_STATE_CACHE = { mtimeMs: -1, bots: [], groups: [] }

function botFileName(value) {
  return String(value ?? '').replace(/[\/:*?"<>|]/g, '_') || 'unnamed'
}

/** 同步读 state.json（按 mtime 缓存）。读失败就沿用上一次的快照，绝不抛。 */
function botStateSync() {
  try {
    const info = statSync(STATE_PATH)
    if (BOT_STATE_CACHE.mtimeMs === info.mtimeMs) return BOT_STATE_CACHE
    const raw = readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/u, '')
    const parsed = JSON.parse(raw)
    const bots = parsed && typeof parsed.bots === 'object' && parsed.bots !== null ? Object.values(parsed.bots) : []
    const groups = parsed && typeof parsed.groups === 'object' && parsed.groups !== null ? Object.values(parsed.groups) : []
    BOT_STATE_CACHE = { mtimeMs: info.mtimeMs, bots, groups }
    return BOT_STATE_CACHE
  } catch {
    return BOT_STATE_CACHE
  }
}

/** 会话 → Bot；与 callerBot() 同一口径。认不出就返回 undefined（＝按用户会话处理）。 */
function botForSessionSync(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const { bots, groups } = botStateSync()
  const direct = bots.find(bot => bot.sessionId === sessionId)
  if (direct !== undefined) return direct
  const viaHistory = bots.find(bot => Array.isArray(bot.history) && bot.history.includes(sessionId))
  if (viaHistory !== undefined) return viaHistory
  for (const group of groups) {
    const branches = group && group.branches
    if (branches === null || typeof branches !== 'object') continue
    for (const [botId, record] of Object.entries(branches)) {
      if (record && record.sessionId === sessionId) {
        const owner = bots.find(bot => bot.id === botId)
        if (owner !== undefined) return owner
      }
    }
  }
  return undefined
}

function botMemoryFile(workspace, rel, botName) {
  return join(workspace, rel, `${botFileName(botName)}.md`)
}

/** 渲染「这个 Bot 的」记忆块。读不到文件也要出块：人设与指令本来就该在。 */
function botMemoryRender(bot, workspace, rel, maxBytes) {
  const file = botMemoryFile(workspace, rel, bot.name)
  const entry = wsIndexRead(file)
  const lines = [
    BOT_MEMORY_MARKER_OPEN,
    `## 你的专属记忆（Bot：${bot.name}）`,
    '',
    `- 身份：${bot.name}${bot.role ? `（${bot.role}）` : ''}${bot.main === true ? ' · 主 Bot' : ''}`,
    `- 工作区：${workspace}`,
    `- 记忆文件：${file}${entry.ok === true ? `（${(entry.size / 1024).toFixed(1)} KB）` : '（尚未建立）'}`,
    '- 口径：这份记忆**只属于你**，同工作区的其他 Bot 与用户会话看不到它。',
  ]
  if (typeof bot.instructions === 'string' && bot.instructions.trim() !== '') {
    lines.push('', '### 你的常驻指令', '', bot.instructions.trim())
  }
  if (entry.ok === true && entry.body !== '') {
    const { text, truncated, dropped } = wsIndexTruncate(entry.body, maxBytes)
    lines.push('', '### 记忆正文', '', text)
    if (truncated) lines.push('', `…（超过 ${maxBytes} 字节，已截断 ${dropped} 字节；完整内容读上面的文件）`)
  } else if (entry.ok !== true) {
    lines.push('', '（还没有专属记忆文件；需要时用 bot_memory_set 写一份。）')
  }
  lines.push(BOT_MEMORY_MARKER_CLOSE)
  return lines.join('\n')
}

function wsIndexSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const enabled = raw.indexEnabled !== false
  const rel = typeof raw.indexFile === 'string' && raw.indexFile.trim() !== '' ? raw.indexFile.trim() : WS_INDEX_DEFAULT_REL
  const maxRaw = Number(raw.indexMaxBytes)
  const maxBytes = Number.isFinite(maxRaw) && maxRaw >= 512 ? Math.min(65536, Math.floor(maxRaw)) : WS_INDEX_DEFAULT_MAX_BYTES
  const orderRaw = Number(raw.indexOrder)
  const order = Number.isFinite(orderRaw) ? orderRaw : 7000
  // 审计 issue #1 第 3 条：默认**不**允许把记忆写到未登记工作区（旧行为是任意绝对路径都放行）。
  const allowUnregisteredWorkspace = raw.allowUnregisteredWorkspace === true
  // Bot 专属记忆（2026-10-22）：默认开；每个 Bot 一份文件，只有它自己的会话注入。
  const botMemoryEnabled = raw.botMemoryEnabled !== false
  const botRel = typeof raw.botMemoryDir === 'string' && raw.botMemoryDir.trim() !== '' ? raw.botMemoryDir.trim() : BOT_MEMORY_DEFAULT_REL
  const botMaxRaw = Number(raw.botMemoryMaxBytes)
  const botMaxBytes = Number.isFinite(botMaxRaw) && botMaxRaw >= 256 ? Math.min(65536, Math.floor(botMaxRaw)) : BOT_MEMORY_DEFAULT_MAX_BYTES
  return { enabled, rel, maxBytes, order, allowUnregisteredWorkspace, botMemoryEnabled, botRel, botMaxBytes }
}

/** 注册装配期上下文贡献。任何一步失败都只留日志，不让插件停在 pending。 */
function wsIndexMount(ctx, settings) {
  if (settings.enabled !== true) return
  if (WS_INDEX_HOST_OWNED.has(basename(settings.rel).toLowerCase())) {
    wsIndexNote(`索引文件名 ${basename(settings.rel)} 归宿主 agent-instructions 管，插件注入已跳过（避免重复）`)
    return
  }
  if (typeof ctx.inject !== 'function') {
    wsIndexNote('ctx.inject 不可用，ws-index 注入未注册')
    return
  }
  try {
    ctx.inject(['systemPrompt'], (spCtx) => {
      const service = spCtx && spCtx.systemPrompt
      if (service === undefined || service === null || typeof service.context !== 'function') {
        wsIndexNote('systemPrompt.context 不可用，ws-index 注入未注册')
        return
      }
      try {
        ctx.effect(() => {
          try {
            return service.context({
              name: 'ws-index:workspace',
              order: settings.order,
              // 同步、纯函数式、永不抛：拿不到就返回空串（等于本会话没有这段）
              text: (assemblyCtx) => {
                try {
                  const cwd = wsIndexCwdOfAssembly(assemblyCtx)
                  if (cwd === '') return ''
                  const blocks = []
                  // ① 工作区块：该工作区**所有会话**共享
                  const file = wsIndexLocate(cwd, settings.rel)
                  if (file !== undefined) {
                    const entry = wsIndexRead(file)
                    if (entry.ok === true) blocks.push(wsIndexRender(entry, cwd, settings.maxBytes))
                    else wsIndexNote(`读取失败 ${file}: ${entry.reason}`)
                  }
                  // ② Bot 专属块：只有**属于某个 Bot 的会话**才注入（用户会话拿不到别人的记忆）
                  if (settings.botMemoryEnabled === true) {
                    const sessionId = assemblyCtx && assemblyCtx.agent ? assemblyCtx.agent.id : undefined
                    const bot = botForSessionSync(sessionId)
                    if (bot !== undefined) {
                      // Bot 的工作区以登记为准：cwd 可能被 cd 走，登记才是真相
                      const botWs = typeof bot.workspace === 'string' && bot.workspace !== '' ? bot.workspace : cwd
                      blocks.push(botMemoryRender(bot, botWs, settings.botRel, settings.botMaxBytes))
                    }
                  }
                  return blocks.join(NEWLINE2)
                } catch (error) {
                  wsIndexNote(`渲染异常: ${error?.message ?? error}`)
                  return ''
                }
              },
            })
          } catch (error) {
            wsIndexNote(`context 注册失败: ${error?.message ?? error}`)
            return () => {}
          }
        }, 'ws-index: workspace index injection')
      } catch (error) {
        wsIndexNote(`effect 注册失败: ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    wsIndexNote(`inject(systemPrompt) 失败: ${error?.message ?? error}`)
  }
}


export function apply(ctx, config = {}) {
  const tool = definition => ctx.tools.register(definition)

  /**
   * sessionController 按需取。
   * 放进 inject 时，只要该服务在激活瞬间还没就绪，整行插件会停在 pending，
   * 表现就是「插件在配置里但工具一个都没注册」。按需取可以避免卡住。
   */
  function controller() {
    const service = ctx.get('sessionController')
    if (service === undefined) throw new Error('sessionController is not available in this profile.')
    return service
  }
  /**
   * 确保该路径在 DSH 的工作区登记表里，返回 workspaceId。
   * 侧栏是按工作区登记表分组的；只给 cwd 建会话会落到"未分组"。
   */
  async function ensureWorkspace(path) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const existing = await registry.resolveByPath(path)
    if (existing !== undefined) return existing.id
    const created = await registry.create(path, path)
    return created.id
  }

  /**
   * 读状态 + 回填（用户口径：功能正常就行，不需要绕过）：
   * 手工登记常缺 workspaceId；这里按 workspace 路径去登记表查一次补上，补齐后落盘。
   * 只补字段，不动会话、不动登记条目。
   */
  async function loadStateInPlugin() {
    const state = await loadState()
    const missing = Object.values(state.bots).filter(bot => bot && !bot.workspaceId && bot.workspace)
    if (missing.length === 0) return state
    let filled = 0
    for (const bot of missing) {
      try {
        const workspaceId = await ensureWorkspace(bot.workspace)
        if (workspaceId !== undefined) {
          bot.workspaceId = workspaceId
          filled += 1
        }
      } catch {
        // 查不到就留空，下一轮再试
      }
    }
    if (filled > 0) {
      state.repairs = [...(Array.isArray(state.repairs) ? state.repairs : []), `回填 workspaceId ${filled} 条`]
      await saveState(state)
    }
    return state
  }

  /**
   * 建会话的唯一入口（P1-4）：
   * 0.2.1 的 `session.create` 明确拒绝 workspaceId 与 cwd 同时出现
   * （实测原文：`session.create accepts workspaceId or cwd, not both`）。
   * 这里只传其中一个：有工作区就传 workspaceId，没有才退回 cwd。
   */
  async function createSession(workspacePath, agentPreset) {
    const workspaceId = await ensureWorkspace(workspacePath)
    const request = workspaceId !== undefined ? { workspaceId } : { cwd: workspacePath }
    if (typeof agentPreset === 'string' && agentPreset !== '') request.agentPreset = agentPreset
    const created = await controller().create(request)
    await ensureUnarchived(created.sessionId)
    if (workspaceId !== undefined) {
      try {
        const registry = ctx.get('workspaceRegistry')
        const entity = registry && typeof registry.get === 'function' ? registry.get(workspaceId) : undefined
        if (entity && typeof entity.attachSession === 'function') await entity.attachSession(created.sessionId)
      } catch {
        // 已在账上就无需再 attach
      }
    }
    return created
  }

  /**
   * 斜杠命令 —— 给不想用工具的人一个「按钮」入口：在 Bot 的对话里输入「/」，
   * 菜单里点「★ 设为主 Bot」即可，再执行一次即取消。
   * 同时注册中文名与 main 两个入口：有些版本对命令名做 ASCII 校验，中文那条失败也不影响 main。
   */
  const registerMainCommand = commandName => {
    try {
      const commandService = ctx.get('commands')
      if (commandService === undefined) return
      const dispose = commandService.register({
        name: commandName,
        description: '★ 把这个对话登记为 Bot 并设为主 Bot（已是 Bot 时：再执行一次＝取消）',
        handler: async invocation => {
          const state = await loadStateInPlugin()
          const sid = invocation.agent.id
          let bot = Object.values(state.bots).find(item => item.sessionId === sid)
          if (bot !== undefined && bot.main !== true) {
            return { kind: 'error', text: `${bot.name} 是角色 Bot，不能改主位；主位只能由用户或当前主 Bot 变更。` }
          }
          let adopted = false
          if (bot === undefined) {
            // 这个会话还没被登记成 Bot：就地收养（登记 id 指向它自己，不新建会话）。
            let cwd = ''
            try {
              const info = await controller().inspect(sid)
              cwd = (info && info.meta && info.meta.cwd) || ''
            } catch {
              cwd = ''
            }
            if (cwd === '') {
              return { kind: 'error', text: '读不到这个会话的工作目录，无法登记为 Bot。请先在这个会话里设置工作区。' }
            }
            let title = ''
            try {
              const proj = await controller().projections({ sessionId: sid }, new AbortController().signal)
              title = (proj && proj.values && typeof proj.values.title === 'string') ? proj.values.title.trim() : ''
            } catch {
              title = ''
            }
            const name = title !== '' ? title : basename(cwd)
            bot = {
              id: sid,
              name,
              role: '主 Bot',
              instructions: '',
              workspace: cwd,
              main: true,
              sessionId: sid,
              createdAt: Date.now(),
              adopted: true,
            }
            state.bots[bot.id] = bot
            adopted = true
          }
          const wsKey = String(bot.workspace ?? '').toLowerCase()
          const makeMain = adopted ? true : bot.main !== true
          for (const item of Object.values(state.bots)) {
            if (String(item.workspace ?? '').toLowerCase() !== wsKey) continue
            if (item.id === bot.id) item.main = makeMain
            else if (makeMain && item.main === true) item.main = false
          }
          await saveState(state)
          if (adopted) {
            return { kind: 'success', text: `已把这个对话登记为 Bot 并设为主 Bot：${bot.name}（${bot.workspace}）` }
          }
          return { kind: 'success', text: `${makeMain ? '已设为主 Bot' : '已取消主 Bot'}：${bot.name}（${bot.workspace}）` }
        },
      })
      ctx.effect(() => dispose)
    } catch {
      // 某个名字不被接受时忽略，另一个入口仍可用
    }
  }
  registerMainCommand('主Bot')
  registerMainCommand('main')

  /**
   * 斜杠命令 /groupmode —— 在本群会话里切换发言模式：
   * broadcast（只有群会话自己回）↔ round-robin（成员依次发言，后者能看到前者）。
   */
  try {
    const commandService = ctx.get('commands')
    if (commandService !== undefined) {
      const dispose = commandService.register({
        name: 'groupmode',
        description: '★ 切换本群发言模式：轮流发言（成员互相看见）/ 广播',
        handler: async invocation => {
          const state = await loadStateInPlugin()
          const sid = invocation.agent.id
          const group = Object.values(state.groups).find(item => item.sessionId === sid)
          if (group === undefined) {
            return { kind: 'error', text: '当前对话不是群聊会话，无法切换群模式。' }
          }
          const next = normalizeGroupMode(group.mode) === 'round-robin' ? 'broadcast' : 'round-robin'
          const groupKey = group.id ?? group.sessionId
          return serializeGroup(groupKey, async () => {
            await mutateState(s => {
              const g = findGroup(s, groupKey)
              if (g) g.mode = next
            })
            return {
              kind: 'success',
              text:
                next === 'round-robin'
                  ? `群「${group.name}」已切到轮流发言：每个成员依次发言，后一位能看到前一位的话。`
                  : `群「${group.name}」已切回广播：只有群会话自己的 agent 会回。`,
            }
          })
        },
      })
      ctx.effect(() => dispose)
    }
  } catch {
    // 命令注册失败不影响工具
  }
  /** 在一个会话里放入一条用户消息，并唤醒它。 */

  /**
   * 归档闸（实测根因）：DSH 的 ArchivedSessionGate 会对**已归档会话**的每一步
   * 直接 reject ⇒ 轮次以 `blocked` 结束、模型根本不发请求。
   * 现象就是"消息投进去了，但对方永远不回"。所以投递/建会话前先取消归档（幂等）。
   */
  async function ensureUnarchived(sessionId) {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof registry.unarchiveSession === 'function') {
        // 签名是 unarchiveSession(sessionId: string)，不是对象（对象形式会被拒，之前就是这样静默失败的）
        await registry.unarchiveSession(sessionId)
      }
    } catch {
      // 没有该能力或本来就没归档：忽略
    }
  }
  /**
   * 把一条发言**写进群会话本身**，这样在 GUI 里打开群会话就能像聊天一样看到。
   * （group.log 是插件的共享记录；用户看不见 state.json，所以必须镜像进会话日志。）
   * 走 agent.inject：durable 的 user 角色消息，不唤醒 agent（不会额外触发模型）。
   * 失败就退回"让群会话自己复述一遍"的方式，保证至少可见。
   */
  /**
   * 把一条发言**直接写进群会话的事件流**，让它在 GUI 里就是一条聊天消息。
   * ★ 两条都不行的路已经踩过：
   *   - agent.inject：只产生 agent/inbox/spliced，UI 不渲染（读回 user/message = 0）；
   *   - 让群会话"原样复述"：多一次模型调用，且不是子 Bot 之间的对话。
   * 正确做法是宿主自己的写法：session.append('user/message', message, { surfaceOp:'append' })。
   * 这样每条发言都是独立一条消息，按时间顺序排在同一条会话里。
   */
  async function appendVisibleMessage(sessionId, who, text) {
    try {
      const resolved = await controller().resolveAgent(sessionId)
      const agent = resolved && resolved.agent
      const session = agent && agent.session
      if (session === undefined || typeof session.append !== 'function') return false
      session.append(
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `${who}：${text}` }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' },
      )
      try {
        const sessions = ctx.get('sessions')
        if (sessions !== undefined && typeof sessions.flush === 'function') await sessions.flush(session)
      } catch {
        // 不 flush 也能落盘，只是晚一点
      }
      return true
    } catch {
      return false
    }
  }

  async function promptSession(sessionId, text) {
    await ensureUnarchived(sessionId)
    // prompt 是 Remote 方法，必须带一个取消信号（否则内部 signal.throwIfAborted() 会崩）
    await controller().prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    )
  }

  /** 该会话当前最后一条事件的序号（轮询起点用）。 */
  async function lastSeq(sessionId) {
    try {
      const info = await controller().inspect(sessionId)
      let max = 0
      for (const event of info.events ?? []) {
        if (typeof event.seq === 'number' && event.seq > max) max = event.seq
      }
      return max
    } catch {
      return 0
    }
  }

  /**
   * 等某个会话把这一轮说完，返回本轮助手文本（没有就返回空串）。
   * 判据：sinceSeq 之后出现 turn/end；文本取该区间内 assistant/message 的 text 块。
   * ★ 踩过的坑：turn/end 常常比 assistant/message **先**落盘（实测两次把"已回复"读成空），
   *   所以看到 turn/end 之后不能立刻返回，要再补读几轮把这一轮的文本收全。
   */
  async function waitForReply(sessionId, sinceSeq, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let text = ''
    const readOnce = async () => {
      let events
      try {
        const info = await controller().inspect(sessionId)
        events = info.events ?? []
      } catch {
        return { ended: false, parts: [] }
      }
      let ended = false
      const parts = []
      for (const event of events) {
        if (typeof event.seq !== 'number' || event.seq <= sinceSeq) continue
        if (event.type === 'turn/end') ended = true
        if (event.type !== 'assistant/message') continue
        const content = event.data?.message?.content ?? event.data?.content ?? []
        const chunk = content.filter(part => part && part.type === 'text').map(part => part.text).join('').trim()
        if (chunk !== '') parts.push(chunk)
      }
      return { ended, parts }
    }
    const startedAt = Date.now()
    while (Date.now() < deadline) {
      // 自适应轮询：前 5 秒密一点（成员常常几秒就答完），之后放稀，减少无谓读取。
      const elapsed = Date.now() - startedAt
      await new Promise(resolve => setTimeout(resolve, elapsed < 5000 ? 300 : 900))
      const { ended, parts } = await readOnce()
      if (parts.length > 0) text = parts.join('\n').trim()
      if (!ended) continue
      // 已结束：最多再补读 4 次（约 6 秒）等文本落盘
      for (let extra = 0; extra < 4 && text === ''; extra += 1) {
        await new Promise(resolve => setTimeout(resolve, 1200))
        const again = await readOnce()
        if (again.parts.length > 0) text = again.parts.join('\n').trim()
      }
      return text
    }
    return text
  }

  /**
   * 群发言模式：broadcast（默认，只投给群会话）/ round-robin（成员依次发言）/ parallel（同一议题并发发给全部成员）。
   * ★ 不接受未知识别值：旧实现把不认识的值一律落回 broadcast 并回"已设为 broadcast"，
   *   那等于静默改语义（用户明确反对）。这里抛错，让调用方看见。
   */
  const GROUP_MODES = ['broadcast', 'round-robin', 'parallel']
  function normalizeGroupMode(value) {
    const mode = String(value ?? '').trim()
    if (mode === '') return 'broadcast'
    if (!GROUP_MODES.includes(mode)) {
      fail(`不支持的群模式：${mode}。可选：${GROUP_MODES.join(' / ')}。`)
    }
    return mode
  }


  /** 群聊的共享记录：一条一条追加，超过 300 条裁掉最旧的（会话日志仍是真相源）。 */
  function appendLog(group, entry) {
    if (!Array.isArray(group.log)) group.log = []
    // ★ seq 必须由当前数组长度/上一条推出：旧调用方在 `group.log` 为空时
    //   用的是另一个局部空数组的 length，导致整轮所有条目 seq 都是 1（实测）。
    const prevSeq = group.log.length > 0 ? group.log[group.log.length - 1].seq : 0
    const nextSeq = (typeof prevSeq === 'number' ? prevSeq : group.log.length) + 1
    const item = { ...entry, seq: nextSeq }
    group.log.push(item)
    if (group.log.length > 300) group.log = group.log.slice(-300)
    return item
  }

  /**
   * 每轮自动留档：<workspace>/讨论/群聊记录_<群名>.md（追加写）。
   * 目的：会话日志之外留一份人可读的记录，重启/换会话也找得回来。
   */
  async function appendRoundFile(group, lines, roundNo) {
    try {
      const dir = join(group.workspace, '讨论')
      await mkdir(dir, { recursive: true })
      const safeName = String(group.name).replace(/[\\/:*?"<>|]/g, '_')
      const file = join(dir, `群聊记录_${safeName}.md`)
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
      const body = [`## 第 ${roundNo} 轮 · ${stamp}`, '', ...lines.map(line => `- ${line}`), ''].join('\n')
      await appendFile(file, body, 'utf8')
      return file
    } catch {
      return ''
    }
  }

  /**
   * 本轮发言者与顺序：默认 admin 先、其余按登记顺序；
   * 传 members（名字或 id 组成的数组）时**只叫这些人，并按给定顺序**（常用来点两三个人互挑）。
   */
  function resolveGroupOrder(state, group, requested) {
    const pool = (group.members ?? [])
      .map(id => state.bots[id] ?? Object.values(state.bots).find(bot => bot.sessionId === id))
      .filter(Boolean)
    if (Array.isArray(requested) && requested.length > 0) {
      const picked = []
      for (const key of requested) {
        const bot = findBot(state, key) ?? pool.find(item => item.name === key)
        if (bot !== undefined && !picked.some(item => item.id === bot.id)) picked.push(bot)
      }
      return picked
    }
    const admin = pool.find(bot => bot.id === group.admin) ?? pool[0]
    return admin === undefined ? pool : [admin, ...pool.filter(bot => bot.id !== admin.id)]
  }

  /** 有界并发：parallel 一次发太多会把宿主/供应商打满；limit=0 表示不限。 */
  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length)
    let cursor = 0
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })
    await Promise.all(runners)
    return results
  }

  /** 每个 (群 × Bot) 的专属目录：<workspace>/.dsh-bot/groups/<群名>/ */
  function safeName(value) {
    return String(value ?? '').replace(/[\\/:*?"<>|]/g, '_')
  }
  function memberDirOf(group) {
    return join(group.workspace, '.dsh-bot', 'groups', safeName(group.name))
  }

  /**
   * 根治：每个 Bot 在每个群里分到**一条专属分支会话 + 一个专属记忆文件**。
   *  · 分支会话：群里发言不带该 Bot 的私聊历史，也不把群内容写进私聊；
   *  · 记忆文件：<workspace>/.dsh-bot/groups/<群>/<Bot>.md，只属于「这个 Bot 在这个群」。
   * 已存在且会话仍可用就复用，不重复创建。
   */
  async function ensureMemberBranch(state, group, bot) {
    if (!group.branches || typeof group.branches !== 'object') group.branches = {}
    const memoryFile = join(memberDirOf(group), `${safeName(bot.name)}.md`)
    const existing = group.branches[bot.id]
    if (existing && typeof existing.sessionId === 'string') {
      try {
        await controller().inspect(existing.sessionId)
        return { sessionId: existing.sessionId, memoryFile: existing.memoryFile ?? memoryFile }
      } catch {
        // 分支会话已不存在：重建
      }
    }
    try {
      await mkdir(memberDirOf(group), { recursive: true })
      const created = await createSession(group.workspace)
      try {
        await controller().rename({ sessionId: created.sessionId, title: `[群] ${group.name} · ${bot.name}` })
      } catch {
        // 标题失败不影响使用
      }
      const record = { sessionId: created.sessionId, memoryFile, createdAt: Date.now() }
      group.branches[bot.id] = record
      try {
        await appendFile(memoryFile, `# ${bot.name} @ 群「${group.name}」\n\n`, 'utf8')
      } catch {
        // 记忆文件写不了不阻塞发言
      }
      return record
    } catch {
      // 建分支失败：退回复用私聊会话，至少还能发言
      return { sessionId: bot.sessionId, memoryFile }
    }
  }

  /** 把这一轮自己说了什么，写进**自己**的群记忆文件。 */
  async function rememberInBranch(memoryFile, roundNo, topic, reply) {
    try {
      const text = String(reply).replace(/\s+/g, ' ').slice(0, 300)
      await appendFile(memoryFile, `- [第 ${roundNo} 轮] 议题：${String(topic).slice(0, 80)} → ${text}\n`, 'utf8')
    } catch {
      // 记忆写失败不影响发言结果
    }
  }

  async function readBranchMemory(memoryFile, maxChars = 1200) {
    try {
      const text = await readFile(memoryFile, 'utf8')
      return text.slice(-maxChars)
    } catch {
      return ''
    }
  }

  /**
   * 叫一位成员发言；空回复/[PASS] 时**重试一次**，仍不行就带回失败原因。
   * 旧实现只写「(未发言)」，看不出是超时、被闸、还是真的没话说。
   * sessionId 缺省用 Bot 的私聊会话；群聊里传它的**分支会话**。
   *
   * ⚠ 审计 issue #1 第 4 条：成员会话被上一轮占着时宿主报
   * `session "…" is already owned by an active turn` / `session/writer-held`，
   * 旧实现直接整轮失败且没有重试语义。现在按「可重试 / 永久失败」分开：
   * 占用类错误退避重投（最多 3 次），其余错误立刻判永久失败，并把类别带回调用方。
   */
  const BUSY_PATTERN = /already owned|writer-held|active turn|active write handle|is busy|正在被占用/i

  /** 投递一条 prompt；返回 { ok, retryable, message }。占用类错误自动退避重投。 */
  async function deliver(sessionId, text, attempts = 3) {
    let last = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await promptSession(sessionId, text)
        return { ok: true, retryable: false, message: '' }
      } catch (error) {
        last = String(error && error.message ? error.message : error)
        if (!BUSY_PATTERN.test(last)) return { ok: false, retryable: false, message: last }
        if (attempt < attempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)))
        }
      }
    }
    return { ok: false, retryable: true, message: last }
  }

  async function askMember(member, buildPrompt, timeoutMs, sessionId = member.sessionId) {
    const first = await lastSeq(sessionId)
    const sent = await deliver(sessionId, buildPrompt())
    if (!sent.ok) {
      const kind = sent.retryable ? '可重试' : '永久失败'
      return { reply: '', reason: `投递失败（${kind}）：${sent.message}`, retryable: sent.retryable }
    }
    let reply = (await waitForReply(sessionId, first, timeoutMs)).trim()
    if (reply !== '' && !/^\[PASS\]$/i.test(reply)) return { reply, reason: '' }
    const retryFrom = await lastSeq(sessionId)
    const again = await deliver(sessionId, '上一条没有收到你的回应。请只用一两句话直接说你的内容；确实无话可说才回 [PASS]。')
    if (again.ok) {
      reply = (await waitForReply(sessionId, retryFrom, Math.min(60_000, timeoutMs))).trim()
    }
    if (reply !== '' && !/^\[PASS\]$/i.test(reply)) return { reply, reason: '' }
    return { reply: '', reason: reply === '' ? '重试一次仍超时/无回应' : '回了 [PASS]', retryable: false }
  }

  tool({
    name: 'bot_create',
    description:
      'MAIN BOT ONLY: create a role Bot inside a workspace. A Session that is a non-Main Bot is refused here — role Bots such as an auditor open conversations with bot_open and send messages with bot_message instead. A Bot is an ordinary DSH Session started in that workspace, so it shows in the Session list like any other conversation.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique Bot name.' },
        workspace: { type: 'string', description: 'Absolute workspace directory this Bot works in.' },
        role: { type: 'string', description: 'Short role label, such as 侦察 / 实施 / 审计 / 反方-审计.' },
        instructions: { type: 'string', description: 'Standing instructions for this Bot.' },
        main: { type: 'boolean', description: 'Mark this Bot as the Main Bot of its workspace. Only the user-facing session may create a Main Bot.' },
        agentPreset: { type: 'string', description: 'Optional DSH agent preset id for the Session.' },
      },
      required: ['name', 'workspace'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      await assertWorkspaceScope(args.workspace, exec, 'workspace')
      const state = await loadStateInPlugin()
      const caller = callerBot(state, exec)
      if (caller !== undefined && caller.main !== true) {
        throw new Error(
          `Only the Main Bot can create Bots. ${caller.name}${caller.role ? ` (${caller.role})` : ''} is a role Bot: use bot_open to start a conversation and bot_message to talk to teammates.`,
        )
      }
      if (args.main === true && caller !== undefined) {
        throw new Error('Only the user-facing session can create a Main Bot; a Main Bot creates child roles.')
      }
      if (findBot(state, args.name)) return fail(`A Bot named ${args.name} already exists.`)
      try {
        await mkdir(args.workspace, { recursive: true })
        await mkdir(memoryDir(args.workspace), { recursive: true })
      } catch (error) {
        return fail(`Cannot use workspace ${args.workspace}: ${error.message}`)
      }
      const created = await createSession(args.workspace, args.agentPreset)
      // P0：bot 对象要记 workspaceId，但它只在 createSession() 内部是局部变量；
      // 早先直接引用外层的 workspaceId ⇒ 必抛 ReferenceError（另一会话实测到的正是这条）。
      const workspaceId = await ensureWorkspace(args.workspace)
      const id = randomUUID()
      const bot = {
        id,
        name: args.name,
        role: args.role ?? '',
        instructions: args.instructions ?? '',
        workspace: args.workspace,
        main: args.main === true,
        workspaceId,
        sessionId: created.sessionId,
        createdAt: Date.now(),
      }
      try {
        await controller().rename({ sessionId: created.sessionId, title: `[Bot] ${args.name}` })
      } catch {
        // 标题只是展示，失败不影响 Bot 可用
      }
      state.bots[id] = bot
      await saveState(state)
      return ok(`Created ${briefBot(bot)}`)
    },
  })

  tool({
    name: 'bot_set_main',
    description:
      'Choose which Bot is the Main Bot of a workspace, or clear it. Only the user-facing session, or that workspace\'s current Main Bot, may switch it. Setting a new Main clears the previous one; main:false clears it outright.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name, Bot id, or Session id.' },
        main: { type: 'boolean', description: 'true (default) makes it the Main Bot; false clears the Main flag.' },
        workspace: { type: 'string', description: 'Optional workspace directory, needed when two Bots share the same name.' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      assertUsablePath(args.workspace, 'workspace')
      const state = await loadStateInPlugin()
      const caller = callerBot(state, exec)
      const key = String(args.bot ?? '').trim()
      const all = Object.values(state.bots)
      // 先按唯一标识（bot id / sessionId）精确命中：同名 Bot（甚至同名且同工作区）时仍可指定到具体那一个。
      const byIdentity = all.filter(bot => bot.id === key || bot.sessionId === key)
      let matches = byIdentity.length > 0 ? byIdentity : all.filter(bot => bot.name === key)
      if (typeof args.workspace === 'string' && args.workspace.trim() !== '') {
        const ws = args.workspace.trim().toLowerCase()
        matches = matches.filter(bot => String(bot.workspace ?? '').toLowerCase() === ws)
      }
      if (matches.length === 0) return fail(`找不到这个 Bot：${key}${args.workspace ? `（工作区 ${args.workspace}）` : ''}`)
      if (matches.length > 1) {
        const lines = matches.map(bot => `${bot.name}  id=${bot.id}  session=${bot.sessionId}  @ ${bot.workspace}`)
        return fail(
          `同名 ${key} 有 ${matches.length} 个，无法凭名字确定是哪一个。请把 bot 参数换成下列任一项的 id 或 sessionId：\n${lines.join('\n')}`,
        )
      }
      const target = matches[0]
      if (caller !== undefined) {
        if (caller.main !== true) {
          return fail(`Only the Main Bot can switch the main Bot. ${caller.name}${caller.role ? ` (${caller.role})` : ''} is a role Bot.`)
        }
        if (String(caller.workspace ?? '').toLowerCase() !== String(target.workspace ?? '').toLowerCase()) {
          return fail('A Main Bot can only switch the main Bot inside its own workspace.')
        }
      }
      const wantMain = args.main !== false
      const changed = []
      const tag = bot => `${bot.name}#${String(bot.id ?? bot.sessionId ?? '').slice(0, 16)}`
      const wsKey = String(target.workspace ?? '').toLowerCase()
      if (wantMain) {
        for (const bot of Object.values(state.bots)) {
          if (String(bot.workspace ?? '').toLowerCase() !== wsKey) continue
          if (bot.id === target.id) {
            if (bot.main !== true) {
              bot.main = true
              changed.push(`+${tag(bot)}`)
            }
          } else if (bot.main === true) {
            bot.main = false
            changed.push(`-${tag(bot)}`)
          }
        }
      } else if (target.main === true) {
        target.main = false
        changed.push(`-${target.name}`)
      }
      await saveState(state)
      const mains = Object.values(state.bots)
        .filter(bot => bot.main === true && String(bot.workspace ?? '').toLowerCase() === wsKey)
        .map(bot => bot.name)
      const suffix = changed.length > 0 ? `  changed: ${changed.join(' ')}` : '  (no change)'
      return ok(`${wantMain ? 'Main Bot' : 'Main cleared'} for ${target.workspace}: ${mains.length > 0 ? mains.join(', ') : '(none)'}${suffix}`)
    },
  })

  tool({
    name: 'bot_list',
    description: 'List Bots grouped by their workspace, with the Session each one runs in.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute() {
      const state = await loadStateInPlugin()
      const bots = Object.values(state.bots)
      if (bots.length === 0) return ok('No Bots yet. Use bot_create.')
      const byWorkspace = new Map()
      for (const bot of bots) {
        if (!byWorkspace.has(bot.workspace)) byWorkspace.set(bot.workspace, [])
        byWorkspace.get(bot.workspace).push(bot)
      }
      const lines = []
      for (const [workspace, list] of [...byWorkspace.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`## ${workspace}`)
        for (const bot of list.sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`- ${briefBot(bot)}${bot.role ? ` — ${bot.role}` : ''}`)
        }
      }
      const groups = Object.values(state.groups)
      if (groups.length > 0) {
        lines.push('', '## 群聊（本身就是会话）')
        for (const group of groups.sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`- ${group.name}  workspace=${group.workspace}  session=${group.sessionId}  members=${(group.members ?? []).length}`)
        }
      }
      const repairs = Array.isArray(state.repairs) ? state.repairs : []
      if (repairs.length > 0) {
        lines.push('', '## 自检（没有删任何登记，只标记）')
        for (const note of [...new Set(repairs)]) lines.push(`- ${note}`)
      }
      return ok(lines.join('\n'))
    },
  })

  tool({
    name: 'bot_message',
    description:
      'Send a message to one Bot; it wakes and answers in its own Session. The result distinguishes "admitted into the inbox" from "this Bot can actually respond": when the target context is unavailable the message is still queued, and the tool says so instead of implying a reply is coming.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot 名字或 id。只放名字本身，不要带 [主] 之类前缀、不要混入正文（正文放 text）。写简称也能解析（如 core-3 → team-core-3）。' },
        text: { type: 'string', description: 'Message to deliver. `message` 是同一参数的别名。40 字内，内容放任务板上。' },
        message: { type: 'string', description: 'Alias of `text`；两者给一个即可。' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()

      // 名字解析：精确优先，其次归一化/前缀/唯一包含。
      // 2026-10-23 实测 53 次 Unknown Bot 全部是**形式差异**而非真错名，
      // 所以这里先尽力解析，解析成功就在回执里说明「我替你补全了」。
      const resolved = resolveBotKey(state, args.bot)
      const bot = resolved.bot
      if (!bot) {
        const tried = (resolved.tried || []).filter(Boolean)
        const cands = resolved.candidates || []
        const lines = []
        if (args.bot === undefined || args.bot === null || String(args.bot).trim() === '') {
          lines.push('bot_message 缺少 bot 参数。')
          lines.push('正确形状：{ "bot": "<Bot名>", "text": "<40字内的一句话>" }')
        } else if (resolved.how === 'ambiguous') {
          lines.push(`Bot 名字有歧义：${String(args.bot).slice(0, 60)}`)
          lines.push(`候选（请写全名）：${cands.join(' / ')}`)
        } else {
          lines.push(`Unknown Bot: ${String(args.bot).slice(0, 80)}`)
          if (tried.length) lines.push(`已尝试的归一化形式：${tried.slice(0, 4).join(' / ')}`)
          if (cands.length) lines.push(`最接近的候选：${cands.join(' / ')}`)
          if (String(args.bot).length > 40) {
            lines.push('提示：bot 字段只放 Bot 名字本身；正文请放 text 字段。')
          }
        }
        return fail(lines.join(' '))
      }
      const body = String(args.text ?? args.message ?? '').trim()
      if (body === '') return fail('bot_message 需要非空的 text（或 message）。')
      await promptSession(bot.sessionId, body)
      // P2-3：prompt 只承诺「入队」。再探一次 agent 是否真能起来，把两种状态分开报。
      let wake = 'unknown'
      let code = ''
      try {
        const resolved = await controller().resolveAgent(bot.sessionId)
        if (resolved && resolved.agent) wake = 'ready'
        else {
          wake = 'unavailable'
          code = resolved && resolved.error && resolved.error.code ? String(resolved.error.code) : ''
        }
      } catch (error) {
        wake = 'unavailable'
        code = error && error.code ? String(error.code) : ''
      }
      // 自动解析过就在回执里说明，避免"我明明写的是 X，怎么发给了 Y"的困惑
      const note = resolved.how === 'exact'
        ? ''
        : `（名字 ${String(args.bot).slice(0, 30)} 已自动解析为 ${bot.name}）`
      if (wake === 'ready') {
        return ok(`已投递并且已唤醒：${bot.name}${note}（session ${bot.sessionId}）会在这个会话里回复。`)
      }
      const reason = code === '' ? '' : `，宿主返回 ${code}`
      return ok(
        `已投递到收件箱，但 ${bot.name} 的上下文当前不可用${reason} —— 它不会响应。` +
          `消息没有丢（会留在它的会话收件箱里）；先打开该会话或重启 DSH 后它才可能处理。`,
      )
    },
  })

  tool({
    name: 'bot_open',
    description:
      'Open a NEW conversation for a role Bot in its workspace: the previous conversation stays in that Bot history, and an optional first message goes into the new one. Role Bots may call this themselves, so a bot such as an auditor can start a conversation instead of only answering.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id.' },
        text: { type: 'string', description: 'Optional first message in the new conversation.' },
        title: { type: 'string', description: 'Optional title for the new conversation.' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const bot = findBot(state, args.bot)
      if (!bot) return fail(`Unknown Bot: ${args.bot}`)
      await mkdir(bot.workspace, { recursive: true })
      const created = await createSession(bot.workspace)
      const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : `[Bot] ${bot.name}`
      try {
        await controller().rename({ sessionId: created.sessionId, title })
      } catch {
        // 标题失败不影响会话可用
      }
      if (bot.sessionId) {
        if (!Array.isArray(bot.history)) bot.history = []
        bot.history.push(bot.sessionId)
      }
      bot.sessionId = created.sessionId
      await saveState(state)
      let firstMessage = ''
      if (typeof args.text === 'string' && args.text.trim() !== '') {
        await promptSession(created.sessionId, args.text)
        // 与 bot_message 同一口径：入队 ≠ 会回复，这里把可响应性一并报出（P2-3）。
        let wake = 'unavailable'
        try {
          const resolved = await controller().resolveAgent(created.sessionId)
          if (resolved && resolved.agent) wake = 'ready'
        } catch {
          wake = 'unavailable'
        }
        firstMessage = wake === 'ready' ? '，首条消息已投递并已唤醒' : '，首条消息已入队（该会话上下文当前不可用，暂不会响应）'
      }
      return ok(`已为 ${bot.name} 开新对话：session ${created.sessionId}${firstMessage}`)
    },
  })

  tool({
    name: 'bot_attach',
    description:
      'Put existing Bot Sessions into their workspace group in the sidebar. This only MOVES an accounted Session inside its workspace: no Session is deleted and nothing is archived. Omit bot to fix every Bot at once.',
    parameters: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Optional Bot name or id; omit for every Bot.' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const state = await loadStateInPlugin()
      const caller = callerBot(state, exec)
      if (caller !== undefined && caller.main !== true) {
        return fail(`只有主 Bot 或用户能整理工作区登记：${caller.name}${caller.role ? ` (${caller.role})` : ''} 是角色 Bot。`)
      }
      const controllerService = ctx.get('workspaceController')
      if (controllerService === undefined) throw new Error('workspaceController is not available in this profile.')
      const targets = args.bot ? [findBot(state, args.bot)].filter(Boolean) : Object.values(state.bots)
      if (targets.length === 0) return ok('No Bots.')
      const lines = []
      for (const bot of targets) {
        try {
          const created = await controllerService.create({ path: bot.workspace })
          const workspaceId = created.workspace.workspaceId
          // 先把会话「记账」进工作区（attachSession），insertSessionBefore 只对已记账的会话有效。
          const registry = ctx.get('workspaceRegistry')
          const entity = registry === undefined ? undefined : registry.get(workspaceId)
          if (entity !== undefined && typeof entity.attachSession === 'function') {
            await entity.attachSession(bot.sessionId)
          }
          try {
            await controllerService.insertSessionBefore({ workspaceId, sessionId: bot.sessionId })
          } catch {
            // 排序失败不影响已经挂进工作区
          }
          bot.workspaceId = workspaceId
          lines.push(`moved ${bot.name} -> ${bot.workspace}`)
        } catch (error) {
          lines.push(`FAILED ${bot.name}: ${error.message}`)
        }
      }
      await saveState(state)
      return ok(lines.join('\n'))
    },
  })

  tool({
    name: 'group_create',
    description:
      'Create a group chat, or adopt an existing DSH Session as a group. A group is a real DSH Session, so it appears in the conversation list exactly like a normal conversation. Adopting never renames, moves or creates anything.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name.' },
        workspace: { type: 'string', description: 'Absolute workspace directory for the group Session.' },
        members: { type: 'array', items: { type: 'string' }, description: 'Bot names to involve.' },
        sessionId: { type: 'string', description: 'Optional: adopt this existing Session as the group instead of creating a new one.' },
        mode: { type: 'string', enum: ['broadcast', 'round-robin', 'parallel'], description: 'broadcast（默认，只有群会话自己回）/ round-robin（成员轮流发言，后者能看到前者）/ parallel（同一议题并发发给全部成员，互相看不到本轮）。' },
      },
      required: ['name', 'workspace'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      await assertWorkspaceScope(args.workspace, exec, 'workspace')
      const state = await loadStateInPlugin()
      const caller = callerBot(state, exec)
      if (caller !== undefined && caller.main !== true) {
        return fail(`只有主 Bot 或用户能建群：${caller.name}${caller.role ? ` (${caller.role})` : ''} 是角色 Bot，可用 bot_message 在已有的群里发言。`)
      }
      if (findGroup(state, args.name)) return fail(`A group named ${args.name} already exists.`)
      const unresolved = []
      const members = []
      for (const memberName of args.members ?? []) {
        const bot = findBot(state, memberName)
        if (bot) members.push(bot.id)
        else {
          members.push(memberName)
          unresolved.push(memberName)
        }
      }
      const note = unresolved.length > 0 ? ` Unresolved member names kept as labels: ${unresolved.join(', ')}.` : ''

      if (args.sessionId) {
        // 收养去重（审计 issue #1 第 2 条）：同一会话被两个群同时收养时，state.json 里会出现
        // 两条同 sessionId 的群记录，之后的 group_post / 成员分支归属就没有唯一答案了。
        const taken = Object.values(state.groups ?? {}).find(group => group && group.sessionId === args.sessionId)
        if (taken !== undefined) {
          return fail(
            `Session ${args.sessionId} 已经是群「${taken.name}」的会话（群 id ${taken.id ?? taken.sessionId}）。` +
              `一个会话只能属于一个群；要换群请先删掉旧群登记，或新建一个会话再收养。`,
          )
        }
        const info = await controller().inspect(args.sessionId)
        const cwd = info && info.meta ? info.meta.cwd : undefined
        if (cwd && join(cwd).toLowerCase() !== join(args.workspace).toLowerCase()) {
          return fail(`Session ${args.sessionId} lives in ${cwd}, not ${args.workspace}. Pass the Session's own workspace.`)
        }
        const id = args.sessionId
        state.groups[id] = {
          id,
          name: args.name,
          workspace: args.workspace,
          sessionId: args.sessionId,
          members,
          mode: normalizeGroupMode(args.mode),
          admin: members[0],
          createdAt: Date.now(),
          adopted: true,
        }
        await saveState(state)
        return ok(`Adopted existing Session ${args.sessionId} as group ${args.name} (members: ${members.length}). Nothing was renamed, moved or created.${note}`)
      }

      await mkdir(args.workspace, { recursive: true })
      const created = await createSession(args.workspace)
      try {
        await controller().rename({ sessionId: created.sessionId, title: `[群] ${args.name}` })
      } catch {
        // 忽略标题失败
      }
      const id = randomUUID()
      state.groups[id] = { id, name: args.name, workspace: args.workspace, sessionId: created.sessionId, members, mode: normalizeGroupMode(args.mode), admin: members[0], createdAt: Date.now() }
      await saveState(state)
      return ok(`Created group ${args.name} as Session ${created.sessionId} (members: ${members.length}).${note}`)
    },
  })

  tool({
    name: 'group_post',
    description: 'Post a message into a group Session. Prefix it with the speaker so members can tell who spoke.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name or id.' },
        text: { type: 'string', description: 'Message text.' },
        from: { type: 'string', description: 'Optional speaker label, such as a Bot name.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本轮只叫这些成员（名字或 id），按给定顺序；省略＝默认顺序（admin 先）。',
        },
        concurrency: { type: 'number', description: 'parallel 模式的并发上限；0 或不传＝无上限（全部同时发）。' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const initial = await loadStateInPlugin()
      const found = findGroup(initial, args.group)
      if (!found) return fail(`Unknown group: ${args.group}`)
      // ★ 2026-10-18 压测修复：同一群按 id 串行排队。排队后再重读 state，
      //   保证第二轮看到第一轮已落盘的 group.log/rounds，不会两份旧快照互相覆盖。
      const groupKey = found.id ?? found.sessionId ?? args.group
      return serializeGroup(groupKey, async () => {
        const state = await loadStateInPlugin()
        const group = findGroup(state, args.group) ?? findGroup(state, groupKey)
        if (!group) return fail(`Unknown group: ${args.group}`)
        await ensureUnarchived(group.sessionId)
        // 不认识的模式直接报错，不再静默落回 broadcast（那等于改了语义还不说）。
        const mode = normalizeGroupMode(group.mode)
        const text = String(args.text ?? '').trim()
        if (text === '') return fail('group_post 需要非空的 text。')
        if (mode === 'broadcast') {
          const prefix = args.from ? `[${args.from}] ` : ''
          await promptSession(group.sessionId, `${prefix}${text}`)
          return ok(`Posted to ${group.name} (session ${group.sessionId})，模式 broadcast（只有群会话自己的 agent 会回）。`)
        }

        // ── 共享一条有序对话（round-robin / parallel 共用）─────────────
        // 每条发言都进同一个 room log；成员看到的 context 来自这份 log，
        // 而不是各自的私聊历史 —— 这样才是在同一个群里说话。
        const order = resolveGroupOrder(state, group, args.members)
        const who = args.from || '用户'
        const roundNo = (typeof group.rounds === 'number' ? group.rounds : 0) + 1
        const prior = await mutateState(s => {
          const g = findGroup(s, groupKey)
          if (!g) return []
          appendLog(g, { who, role: 'user', text, time: Date.now() })
          return g.log.slice(0, -1).slice(-8).map(line => ({ who: line.who, text: line.text }))
        })
        await appendVisibleMessage(group.sessionId, who, text)
        if (order.length === 0) {
          return ok(`群 ${group.name} 没有可用的成员 Bot；这条消息只记进了群记录。`)
        }
        const roundEntries = [{ who, text }]
        const replies = []

        // 根治：每个 (群 × Bot) 一条专属分支会话 + 一个专属记忆文件。
        // 分支会话让发言不带私聊历史；记忆文件只属于「这个 Bot 在这个群」。
        const branches = {}
        await mutateState(async stateForBranches => {
          const g = findGroup(stateForBranches, groupKey)
          if (!g) return
          for (const member of order) {
            branches[member.id] = await ensureMemberBranch(stateForBranches, g, member)
          }
          return undefined
        })
        const branchOf = member =>
          branches[member.id] ?? { sessionId: member.sessionId, memoryFile: '' }

        /**
         * 审计 issue #1 第 4 条：成员会话被占时，旧实现整轮失败且没有重试语义。
         * 投递层已按「占用类错误」退避重投（见 deliver）；仍失败且判定为**可重试**的成员，
         * 在本轮末尾按顺序再补投一次，并把结果并回 replies。永久失败的不重投（重投也没用）。
         */
        const retryable = []
        const retryPass = async (pending, lines, entries) => {
          if (pending.length === 0) return ''
          const recovered = []
          for (const item of pending) {
            const prompt = [
              '上一轮你的会话正被占用，所以没能发言。请补上你这一轮要说的话；确实没有就回 [PASS]。',
              '直接说内容，不要加名字前缀；语言与用户此条消息一致。',
            ].join('\n')
            const again = await askMember(item.member, () => prompt, 60_000, item.branch.sessionId)
            if (again.reply !== '') {
              const body = again.reply
              await mutateState(s2 => {
                const g = findGroup(s2, groupKey)
                if (g) appendLog(g, { who: item.member.name, role: 'bot', text: body, time: Date.now() })
              })
              await appendVisibleMessage(group.sessionId, item.member.name, body)
              entries.push({ who: item.member.name, text: body })
              const idx = lines.findIndex(line => line.startsWith(`${item.member.name}：`))
              if (idx >= 0) lines[idx] = `${item.member.name}：${body}`
              else lines.push(`${item.member.name}：${body}`)
              recovered.push(item.member.name)
            }
          }
          const still = pending.length - recovered.length
          const parts = []
          if (recovered.length > 0) parts.push(`已补投 ${recovered.length} 位（${recovered.join('、')}）`)
          if (still > 0) parts.push(`${still} 位仍被占用，可稍后重发本轮`)
          return parts.length > 0 ? `；${parts.join('；')}` : ''
        }

        const finish = async () => {
          await mutateState(s => {
            const g = findGroup(s, groupKey)
            if (g) g.rounds = roundNo
          })
          // 关键（上游 96a45860）：本轮必须先把 state 落盘再释放群队列；否则下一轮
          // loadStateInPlugin() 会读到 150ms 合并写之前的旧快照，丢掉上一轮的 log/rounds。
          await flushStateWrites()
          const file = await appendRoundFile(group, roundEntries.map(entry => `${entry.who}：${entry.text}`), roundNo)
          return file
        }

        // ── parallel：同一议题一次发给所有人，并发等待，互不阻塞 ────────
        if (mode === 'parallel') {
          // 默认**无上限**：全部成员同时发（用户明确要求）。要限流就传 concurrency > 0。
          const limit = typeof args.concurrency === 'number' && args.concurrency > 0 ? args.concurrency : 0
          const send = async member => {
              const branch = branchOf(member)
              const lines = []
              lines.push(`你是「${group.name}」这个群聊的成员：${member.name}。群成员：${order.map(bot => bot.name).join('、')}。`)
              lines.push('本轮是并发讨论：所有成员同时作答，你看不到别人本轮的发言（这是设计），请独立给出你的看法。')
              const mine = await readBranchMemory(branch.memoryFile)
              if (mine !== '') {
                lines.push(`【你在本群的专属记忆（你自己的文件，只有你在这个群里的历史）】\n${mine}`)
              }
              if (prior.length > 0) {
                lines.push(`【本轮之前的上下文，仅供参考】\n${prior.map(line => `${line.who}：${line.text}`).join('\n')}`)
              }
              lines.push(`【本议题】\n${who}：${text}`)
              lines.push('直接说你的内容，不要加名字前缀；确实无话可说才回 [PASS]。')
              lines.push('语言：与用户此条消息同一种语言（用户用中文就用中文），不要自行切换成英文。')
              const result = await askMember(member, () => lines.join('\n\n'), 120_000, branch.sessionId)
              await rememberInBranch(branch.memoryFile, roundNo, text, result.reply === '' ? `（未发言：${result.reason}）` : result.reply)
              return { member, ...result }
          }
          const results = limit === 0 ? await Promise.all(order.map(send)) : await mapLimit(order, limit, send)
          for (const result of results) {
            const body = result.reply === '' ? `(未发言：${result.reason})` : result.reply
            await mutateState(s => {
              const g = findGroup(s, groupKey)
              if (g) appendLog(g, { who: result.member.name, role: result.reply === '' ? 'pass' : 'bot', text: body, time: Date.now() })
            })
            if (result.reply !== '') await appendVisibleMessage(group.sessionId, result.member.name, result.reply)
            roundEntries.push({ who: result.member.name, text: body })
            replies.push(`${result.member.name}：${body}`)
            if (result.reply === '' && result.retryable === true) retryable.push({ member: result.member, branch: branchOf(result.member) })
          }
          const file = await finish()
          const retryNote = await retryPass(retryable, replies, roundEntries)
          return ok(`群「${group.name}」本轮结束（parallel 并发 ${order.length} 位${file ? `，已留档 ${file}` : ''}${retryNote}）：\n\n${replies.join('\n\n')}`)
        }

        // ── round-robin：成员依次发言，后者能看到前者 ─────────────────
        for (let index = 0; index < order.length; index += 1) {
          const member = order[index]
          const branch = branchOf(member)
          const lines = []
          lines.push(`你是「${group.name}」这个群聊的成员：${member.name}。群成员：${order.map(bot => bot.name).join('、')}。`)
          lines.push('成员一次只一个人说话，每条发言都会先发到群里，下一位才开口。不要重复别人已经说过的内容。')
          const mine = await readBranchMemory(branch.memoryFile)
          if (mine !== '') {
            lines.push(`【你在本群的专属记忆（你自己的文件，只有你在这个群里的历史）】\n${mine}`)
          }
          if (prior.length > 0) {
            lines.push(`【本轮之前的上下文，仅供参考】\n${prior.map(line => `${line.who}：${line.text}`).join('\n')}`)
          }
          lines.push(`【本轮到目前为止（从旧到新）】\n${roundEntries.map(line => `${line.who}：${line.text}`).join('\n')}`)
          lines.push(`本轮发言顺序：${order.map(bot => bot.name).join(' → ')}。`)
          lines.push(`你是第 ${index + 1} / ${order.length} 位：你之前有 ${index} 位发过言，之后还有 ${order.length - index - 1} 位会看到你的发言。`)
          lines.push('直接说你这一轮要说的内容，不要加名字前缀；如果确实没有要补充的，只回 [PASS]。')
          lines.push('语言：与用户此条消息同一种语言（用户用中文就用中文），不要自行切换成英文。')
          const result = await askMember(member, () => lines.join('\n\n'), 90_000, branch.sessionId)
          await rememberInBranch(branch.memoryFile, roundNo, text, result.reply === '' ? `（未发言：${result.reason}）` : result.reply)
          const body = result.reply === '' ? `(未发言：${result.reason})` : result.reply
          await mutateState(s => {
            const g = findGroup(s, groupKey)
            if (g) appendLog(g, { who: member.name, role: result.reply === '' ? 'pass' : 'bot', text: body, time: Date.now() })
          })
          if (result.reply !== '') await appendVisibleMessage(group.sessionId, member.name, result.reply)
          roundEntries.push({ who: member.name, text: body })
          replies.push(`${member.name}：${body}`)
          if (result.reply === '' && result.retryable === true) retryable.push({ member, branch })
        }
        const file = await finish()
        const retryNote = await retryPass(retryable, replies, roundEntries)
        return ok(`群「${group.name}」本轮结束（${order.length} 位成员，顺序 ${order.map(bot => bot.name).join(' → ')}${file ? `，已留档 ${file}` : ''}${retryNote}）：\n\n${replies.join('\n\n')}`)
      })
    },
  })

  tool({
    name: 'group_set_mode',
    description:
      'Switch a group between broadcast (only the group Session agent answers) and round-robin (each member Bot speaks in turn, each seeing what the previous ones said). Only the user or a Main Bot may switch it.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name or id.' },
        mode: { type: 'string', enum: ['broadcast', 'round-robin', 'parallel'], description: 'broadcast = 只有群会话自己回；round-robin = 成员轮流发言；parallel = 并发发给全部成员。' },
      },
      required: ['group', 'mode'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const state = await loadStateInPlugin()
      const caller = callerBot(state, exec)
      if (caller !== undefined && caller.main !== true) {
        return fail(`只有主 Bot 或用户能改群模式：${caller.name} 是角色 Bot。`)
      }
      const group = findGroup(state, args.group)
      if (!group) return fail(`Unknown group: ${args.group}`)
      const groupKey = group.id ?? group.sessionId ?? args.group
      // 与 group_post 共用一个群队列：改模式不会插进正在进行的轮次中间。
      return serializeGroup(groupKey, async () => {
        await ensureUnarchived(group.sessionId)
        const mode = await mutateState(s => {
          const g = findGroup(s, groupKey)
          if (!g) return null
          g.mode = normalizeGroupMode(args.mode)
          return g.mode
        })
        if (mode === null) return fail(`Unknown group: ${args.group}`)
        const tail =
          mode === 'round-robin'
            ? '（成员依次发言，后者能看到前者）'
            : mode === 'parallel'
              ? '（同一议题并发发给全部成员，本轮互相看不到）'
              : '（只有群会话自己回）'
        return ok(`群「${group.name}」发言模式已设为 ${mode}${tail}。`)
      })
    },
  })

  tool({
    name: 'group_read',
    description: 'Read the most recent messages of a group Session (or any Session by id).',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name, group id, or a raw session id.' },
        limit: { type: 'number', description: 'How many recent messages, default 20.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const group = findGroup(state, args.group)
      const sessionId = group ? group.sessionId : args.group
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20
      // ★ 2026-10-18 压测修复：**会话是真相源**，优先读会话事件；group.log 只做兜底。
      //   旧实现只要 log 非空就只回 log，实测并发压测里 log 丢了一轮，
      //   于是 group_read 把另一轮的 8 条可见发言整体藏掉了。
      let inspection = null
      try {
        inspection = await controller().inspect(sessionId)
      } catch {
        inspection = null
      }
      // 会话日志里两类事件的形状不同：
      //   user/message      -> data.content            （直接挂 content）
      //   assistant/message -> data.message.content    （包在 message 里）
      // 早先只读 data.message.content，导致群聊里 85 条用户侧消息全被判"没有消息"。
      const NOISE = ['Current runtime context', '<system-reminder>', '<attention_orchestration', 'Repeated tool call detected']
      const rows = []
      for (const event of inspection?.events ?? []) {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        const parts = event.data?.message?.content ?? event.data?.content ?? []
        const text = parts.filter(part => part && part.type === 'text').map(part => part.text).join('').trim()
        if (text === '') continue
        if (NOISE.some(prefix => text.startsWith(prefix))) continue
        // 群成员发言本身就是 `who：text` 形态的 user/message，别再叠一层 "User:"。
        rows.push(event.type === 'user/message' ? text : `Assistant: ${text}`)
      }
      const tail = rows.slice(-limit)
      if (tail.length > 0) {
        if (!group) return ok(tail.join('\n\n'))
        const logCount = Array.isArray(group.log) ? group.log.length : 0
        const head = `群「${group.name}」· 模式 ${normalizeGroupMode(group.mode)} · 会话可见 ${rows.length} 条`
        const note = logCount > 0 && logCount !== rows.length
          ? `\n（派生 group.log ${logCount} 条；与会话不一致时以会话为准）`
          : ''
        return ok([head, ...tail].join('\n') + note)
      }
      // 会话暂无消息：退回 group.log（例如刚写入、事件尚未 flush）
      if (group && Array.isArray(group.log) && group.log.length > 0) {
        const tailLog = group.log.slice(-limit)
        const head = `群「${group.name}」· 模式 ${normalizeGroupMode(group.mode)} · 派生记录 ${group.log.length} 条（会话事件为空）`
        return ok([head, ...tailLog.map(line => `${line.who}：${line.text}`)].join('\n'))
      }
      // 另一会话实测：消息刚发、事件还没落盘时读会得到空。这里给出可判的说明而不是假装"没有消息"。
      const events = inspection?.events ?? []
      const lastTime = events.reduce((max, event) => (typeof event.time === 'number' && event.time > max ? event.time : max), 0)
      const ageMs = lastTime > 0 ? Date.now() - lastTime : null
      if (ageMs !== null && ageMs < 10000) {
        return ok(`（暂无已落盘的可读消息：该会话最后一次活动在 ${Math.round(ageMs / 1000)} 秒前，事件可能还没写完，稍后再读一次）`)
      }
      return ok(`(no messages in ${sessionId})`)
    },
  })

  tool({
    name: 'session_probe',
    description:
      'Diagnose ONE DSH Session: call inspect, projections, page and resolveAgent in order and report which one fails and with what error. Read-only apart from resuming the agent.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id to probe.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const lines = []
      const sid = args.sessionId
      let ctl
      try {
        ctl = controller()
      } catch (error) {
        return ok(`controller unavailable: ${error && error.message ? error.message : String(error)}`)
      }
      try {
        const info = await ctl.inspect(sid)
        lines.push(`inspect      OK   events=${(info && info.events ? info.events.length : 0)} cwd=${info && info.meta ? info.meta.cwd : ''} preset=${info && info.meta ? info.meta.agentPreset : ''} inherited=${info ? info.inheritedEventCount : ''}`)
      } catch (error) {
        lines.push(`inspect      FAIL ${error && error.message ? error.message : String(error)}`)
      }
      let asOfSeq = null
      try {
        const proj = await ctl.projections({ sessionId: sid }, new AbortController().signal)
        if (proj && typeof proj.asOfSeq === 'number') asOfSeq = proj.asOfSeq
        lines.push(`projections  ${proj ? 'OK ' + JSON.stringify(proj).slice(0, 200) : 'NULL (no projections)'}`)
      } catch (error) {
        lines.push(`projections  FAIL ${error && error.message ? error.message : String(error)}`)
        if (error && error.stack) lines.push('   stack: ' + String(error.stack).split('\n').slice(0, 4).join(' | '))
      }
      try {
        // throughSeq 必须 ≤ 当前 cursor，否则宿主直接拒绝（早先这里恒发 MAX_SAFE_INTEGER，等于每次都假失败）
        const through = typeof asOfSeq === 'number' ? asOfSeq : 0
        const page = await ctl.page({ address: { kind: 'session', sessionId: sid }, throughSeq: through, maxMessages: 2 }, new AbortController().signal)
        lines.push(`page         OK   records=${page && page.records ? page.records.length : 0} hasMore=${page ? page.hasMore : ''}`)
      } catch (error) {
        lines.push(`page         FAIL ${error && error.message ? error.message : String(error)}`)
        if (error && error.stack) lines.push('   stack: ' + String(error.stack).split('\n').slice(0, 4).join(' | '))
      }
      try {
        const agent = await ctl.resolveAgent(sid)
        lines.push(`resolveAgent ${agent && agent.agent ? 'OK   agent=' + agent.agent.id : 'RESULT ' + JSON.stringify(agent).slice(0, 300)}`)
      } catch (error) {
        lines.push(`resolveAgent FAIL ${error && error.message ? error.message : String(error)} code=${error && error.code ? error.code : ''} details=${error && error.details ? JSON.stringify(error.details).slice(0, 200) : ''}`)
        if (error && error.stack) lines.push('   stack: ' + String(error.stack).split('\n').slice(0, 6).join(' | '))
      }
      try {
        const commands = ctx.get('commands')
        if (commands === undefined) {
          lines.push('commands     skipped (service unavailable)')
        } else {
          const list = await commands.list({ id: sid })
          const names = (list ?? []).map(item => item.name)
          const wanted = names.filter(item => item === '主Bot' || item === 'main')
          lines.push(`commands     total=${names.length}  ours=[${wanted.join(', ')}]`)
        }
      } catch (error) {
        lines.push(`commands     FAIL ${error && error.message ? error.message : String(error)}`)
      }
      return ok(lines.join('\n'))
    },
  })

  tool({
    name: 'workspace_memory_remember',
    description:
      'Append a note to ONE workspace memory. Each workspace keeps its own memory file, so notes never leak across projects. Use topic to file it under a named section file.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Absolute workspace directory.' },
        text: { type: 'string', description: 'What to remember.' },
        topic: { type: 'string', description: 'Optional topic name; stored as topics/<topic>.md.' },
      },
      required: ['workspace', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      await assertWorkspaceScope(args.workspace, exec, 'workspace')
      const dir = memoryDir(args.workspace)
      await mkdir(join(dir, 'topics'), { recursive: true })
      const stamp = new Date().toISOString()
      const line = `- (${stamp}) ${args.text}\n`
      if (args.topic) {
        const slug = String(args.topic).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 60)
        const file = join(dir, 'topics', `${slug}.md`)
        try {
          await readFile(file, 'utf8')
        } catch {
          await writeFile(file, `# ${args.topic}\n\n`, 'utf8')
        }
        await appendFile(file, line, 'utf8')
        return ok(`Remembered in ${args.workspace} topic "${args.topic}".`)
      }
      const file = join(dir, 'MEMORY.md')
      try {
        await readFile(file, 'utf8')
      } catch {
        await writeFile(file, `# Workspace memory: ${args.workspace}\n\n`, 'utf8')
      }
      await appendFile(file, line, 'utf8')
      return ok(`Remembered in ${args.workspace} (MEMORY.md).`)
    },
  })

  tool({
    name: 'workspace_memory_recall',
    description: 'Read one workspace memory. Optionally filter by a plain-text query.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Absolute workspace directory.' },
        query: { type: 'string', description: 'Optional substring filter.' },
      },
      required: ['workspace'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      assertUsablePath(args.workspace, 'workspace')
      const dir = memoryDir(args.workspace)
      const files = [join(dir, 'MEMORY.md')]
      try {
        const { readdir } = await import('node:fs/promises')
        const topics = await readdir(join(dir, 'topics'))
        for (const name of topics) if (name.endsWith('.md')) files.push(join(dir, 'topics', name))
      } catch {
        // 没有 topics 目录就只读 MEMORY.md
      }
      const chunks = []
      for (const file of files) {
        let text
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        if (args.query) {
          const needle = String(args.query).toLowerCase()
          const kept = text.split('\n').filter(line => line.toLowerCase().includes(needle))
          if (kept.length === 0) continue
          chunks.push(`# ${file}\n${kept.join('\n')}`)
        } else {
          chunks.push(`# ${file}\n${text.trim()}`)
        }
      }
      return ok(chunks.length === 0 ? `(no memory for ${args.workspace})` : chunks.join('\n\n'))
    },
  })

  // ── 工作区索引记忆：注入 + 两个配套工具（v0.2 新增）─────────────────────
  const indexSettings = wsIndexSettings(config)
  wsIndexMount(ctx, indexSettings)

  /**
   * 工作区闸（审计 issue #1 第 3 条）：`workspace` 参数此前接受任意绝对路径，
   * 于是记忆/索引可以写到仓库外任意可写目录（实测写进 %TEMP%/bot-outside/）。
   * 现在的口径：**已登记工作区**，或**调用方自己会话 cwd 及其子目录**；两者之外一律拒绝。
   * 明确要越界时，配置 `allowUnregisteredWorkspace: true` 才放行（风险自负，写在 README）。
   */
  async function assertWorkspaceScope(path, exec, label = 'workspace') {
    const text = assertUsablePath(path, label)
    if (text === '') fail(`${label} 不能为空。`)
    if (indexSettings.allowUnregisteredWorkspace === true) return text
    let target
    try {
      target = resolve(text)
    } catch {
      fail(`${label} 不是合法路径：${text}`)
    }
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.resolveByPath === 'function') {
      try {
        if ((await registry.resolveByPath(target)) !== undefined) return text
      } catch {
        // 查不动登记表就继续按 cwd 判，不因查表失败而放行
      }
    }
    const cwd = wsIndexAgentCwd(exec && exec.agent)
    if (cwd !== '') {
      const base = resolve(cwd).replace(/[\\/]+$/u, '').toLowerCase()
      const cand = target.replace(/[\\/]+$/u, '').toLowerCase()
      if (cand === base || cand.startsWith(`${base}\\`) || cand.startsWith(`${base}/`)) return text
    }
    fail(
      `${label} 不在已登记工作区里，也不是本会话工作目录：${target}\n` +
        `两条出路：①在 GUI 里把该目录「添加为工作区」后再传；②确认要越界时，给插件配置 allowUnregisteredWorkspace: true。`,
    )
  }

  tool({
    name: 'ws_index_show',
    description:
      'Read-only: show the workspace index-memory block exactly as this plugin injects it into the system prompt, plus which file was found and its size/mtime. Use it to verify that a workspace index is really being injected.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: "Absolute workspace directory; defaults to this session's working directory." },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const target = args.workspace !== undefined && args.workspace !== null && String(args.workspace).trim() !== ''
        ? assertUsablePath(args.workspace, 'workspace')
        : wsIndexAgentCwd(exec && exec.agent)
      if (target === '') return fail('读不到本会话的工作目录，请显式传 workspace。')
      const file = wsIndexLocate(target, indexSettings.rel)
      if (file === undefined) {
        return ok(
          `本工作区没有索引文件 ⇒ 本会话**没有**被注入。\n` +
            `期望位置：${isAbsolute(indexSettings.rel) ? indexSettings.rel : join(target, indexSettings.rel)}\n` +
            `写一份：ws_index_set(workspace=..., content=...)。`,
        )
      }
      const entry = wsIndexRead(file)
      if (entry.ok !== true) return fail(`索引文件存在但读不了：${entry.reason}（${file}）`)
      return ok(
        [
          `注入开关：${indexSettings.enabled ? '已启用' : '已停用（配置 indexEnabled=false）'}`,
          `索引文件：${file}`,
          `大小：${entry.size} B / 注入上限 ${indexSettings.maxBytes} B`,
          `更新：${new Date(entry.mtimeMs).toISOString()}`,
          '',
          wsIndexRender(entry, target, indexSettings.maxBytes),
        ].join('\n'),
      )
    },
  })

  tool({
    name: 'ws_index_set',
    description:
      'Write (replace or append) the workspace index-memory file that this plugin injects into every session of that workspace. Creates the .dsh-bot/ directory when missing.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Absolute workspace directory.' },
        content: { type: 'string', description: 'Markdown to write.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) overwrites the file; append adds after the existing body.' },
      },
      required: ['workspace', 'content'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const ws = await assertWorkspaceScope(args.workspace, exec, 'workspace')
      if (ws === '') return fail('workspace 不能为空。')
      if (typeof args.content !== 'string' || args.content.trim() === '') return fail('content 不能为空。')
      const file = isAbsolute(indexSettings.rel) ? indexSettings.rel : join(ws, indexSettings.rel)
      const mode = args.mode === 'append' ? 'append' : 'replace'
      try {
        await mkdir(dirname(file), { recursive: true })
        if (mode === 'append') {
          let prev = ''
          try {
            prev = await readFile(file, 'utf8')
          } catch {
            prev = ''
          }
          const head = prev.trim() === '' ? '# 工作区索引记忆\n\n' : prev.replace(/\s*$/u, '\n')
          await writeFile(file, `${head}\n${args.content.replace(/\r\n/g, '\n').trim()}\n`, 'utf8')
        } else {
          await writeFile(file, `${args.content.replace(/\r\n/g, '\n').trim()}\n`, 'utf8')
        }
      } catch (error) {
        return fail(`写入失败：${error?.message ?? error}`)
      }
      WS_INDEX_CACHE.delete(file) // 立即失效：下一轮装配就读到新内容
      const entry = wsIndexRead(file)
      const size = entry.ok === true ? entry.size : 0
      const over = size > indexSettings.maxBytes
      return ok(
        `${mode === 'append' ? '已追加' : '已写入'}：${file}（${size} B）。下一轮装配起自动注入。` +
          (over ? `\n⚠ 已超过注入上限 ${indexSettings.maxBytes} B，注入时会被截断；建议把正文挪到别的文件、这里只留索引。` : ''),
      )
    },
  })

  tool({
    name: 'bot_memory_show',
    description:
      "Read-only: show ONE Bot's private memory block exactly as it is injected into that Bot's own sessions (identity + standing instructions + memory body). Omit bot to resolve it from the calling session.",
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id. Omit to resolve the Bot that owns the calling session.' },
        workspace: { type: 'string', description: "Bot's workspace; defaults to the resolved Bot's registered workspace." },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const state = await loadStateInPlugin()
      const key = typeof args.bot === 'string' && args.bot.trim() !== '' ? args.bot.trim() : undefined
      let bot
      if (key !== undefined) {
        const all = Object.values(state.bots ?? {})
        const byIdentity = all.filter(item => item.id === key || item.sessionId === key)
        const matches = byIdentity.length > 0 ? byIdentity : all.filter(item => item.name === key)
        if (matches.length === 0) return fail(`找不到这个 Bot：${key}`)
        if (matches.length > 1) {
          return fail(`同名 ${key} 有 ${matches.length} 个，请改用 id 或 sessionId：${matches.map(item => `${item.name} id=${item.id}`).join('；')}`)
        }
        bot = matches[0]
      } else {
        const sessionId = exec && exec.agent ? exec.agent.id : undefined
        bot = botForSessionSync(sessionId)
        if (bot === undefined) {
          return fail('本会话不属于任何 Bot（用户会话拿不到 Bot 的专属记忆）。请显式传 bot 参数。')
        }
      }
      const ws = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? args.workspace.trim() : String(bot.workspace ?? '')
      if (ws === '') return fail(`Bot ${bot.name} 没有登记工作区。`)
      const file = botMemoryFile(ws, indexSettings.botRel, bot.name)
      const entry = wsIndexRead(file)
      return ok(
        [
          `Bot：${bot.name}${bot.role ? `（${bot.role}）` : ''}${bot.main === true ? ' · 主 Bot' : ''}`,
          `记忆文件：${file}${entry.ok === true ? `（${entry.size} B / 注入上限 ${indexSettings.botMaxBytes} B）` : '（不存在）'}`,
          `注入开关：${indexSettings.botMemoryEnabled ? '已启用' : '已停用（botMemoryEnabled=false）'}`,
          '',
          botMemoryRender(bot, ws, indexSettings.botRel, indexSettings.botMaxBytes),
        ].join('\n'),
      )
    },
  })

  tool({
    name: 'bot_memory_set',
    description:
      "Write (replace or append) ONE Bot's private memory file at <workspace>/.dsh-bot/bots/<bot>.md. Only that Bot's own sessions get it injected; other Bots and user sessions never see it.",
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id.' },
        content: { type: 'string', description: 'Markdown to write.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) overwrites; append adds after the existing body.' },
        workspace: { type: 'string', description: "Bot's workspace; defaults to the Bot's registered workspace." },
      },
      required: ['bot', 'content'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      const state = await loadStateInPlugin()
      const key = String(args.bot ?? '').trim()
      if (key === '') return fail('bot 不能为空。')
      if (typeof args.content !== 'string' || args.content.trim() === '') return fail('content 不能为空。')
      const all = Object.values(state.bots ?? {})
      const byIdentity = all.filter(item => item.id === key || item.sessionId === key)
      const matches = byIdentity.length > 0 ? byIdentity : all.filter(item => item.name === key)
      if (matches.length === 0) return fail(`找不到这个 Bot：${key}`)
      if (matches.length > 1) {
        return fail(`同名 ${key} 有 ${matches.length} 个，请改用 id 或 sessionId：${matches.map(item => `${item.name} id=${item.id}`).join('；')}`)
      }
      const bot = matches[0]
      const ws = typeof args.workspace === 'string' && args.workspace.trim() !== ''
        ? await assertWorkspaceScope(args.workspace, exec, 'workspace')
        : String(bot.workspace ?? '')
      if (ws === '') return fail(`Bot ${bot.name} 没有登记工作区，请显式传 workspace。`)
      const file = botMemoryFile(ws, indexSettings.botRel, bot.name)
      const mode = args.mode === 'append' ? 'append' : 'replace'
      try {
        await mkdir(dirname(file), { recursive: true })
        if (mode === 'append') {
          let prev = ''
          try {
            prev = await readFile(file, 'utf8')
          } catch {
            prev = ''
          }
          const head = prev.trim() === '' ? `# ${bot.name} 的专属记忆` + NEWLINE2 : prev.replace(/\s*$/u, '\n')
          await writeFile(file, `${head}\n${args.content.replace(/\r\n/g, '\n').trim()}\n`, 'utf8')
        } else {
          await writeFile(file, `${args.content.replace(/\r\n/g, '\n').trim()}\n`, 'utf8')
        }
      } catch (error) {
        return fail(`写入失败：${error?.message ?? error}`)
      }
      WS_INDEX_CACHE.delete(file)
      const entry = wsIndexRead(file)
      const size = entry.ok === true ? entry.size : 0
      const over = size > indexSettings.botMaxBytes
      return ok(
        `${mode === 'append' ? '已追加' : '已写入'}：${file}（${size} B）。` +
          `下一轮装配起，只有 **${bot.name}** 自己的会话会看到这段；其他 Bot 与用户会话看不到。` +
          (over ? `\n⚠ 已超过注入上限 ${indexSettings.botMaxBytes} B，注入时会被截断。` : ''),
      )
    },
  })

  // ── bot_note：不唤醒的投递（R25 需求侧）────────────────────────────
  // 为什么要它：实测 9866 个 turn 里，F+P×steps 的固定开销只占 12.2%，
  // 所以「每轮多吃几条」最多只值 1.14×（见 dispatcher.js 头注释）。
  // 真正的大头是**根本不该占一个 turn 的消息**：汇报、抄送、规则广播。
  // 一条这样的消息占掉一个 turn，就占掉 293.5s 的并发槽。
  // bot_note 把它降级成一次文件追加：不建 turn、不花模型调用，
  // 收件人下次干活时自己读（就像读任务板一样）。
  const NOTE_DIR = join(HOME, 'bot-ours', 'notes')

  tool({
    name: 'bot_note',
    description:
      'Leave a note for a Bot WITHOUT waking it. Use this for reports, status updates, FYI, and rule broadcasts — anything the recipient does not need to act on immediately. It appends to that Bot note file and costs no model turn; the recipient reads it the next time it works. Use bot_message only when the recipient must act now.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id.' },
        text: { type: 'string', description: 'Note content.' },
        from: { type: 'string', description: 'Optional sender label.' },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const bot = findBot(state, args.bot)
      if (!bot) return fail(`Unknown Bot: ${args.bot}`)
      const body = String(args.text ?? '').trim()
      if (body === '') return fail('bot_note 需要非空的 text。')
      const who = String(args.from ?? '').trim()
      const line = JSON.stringify({
        at: new Date().toISOString(),
        from: who === '' ? null : who,
        text: body,
      })
      try {
        await mkdir(NOTE_DIR, { recursive: true })
        await appendFile(join(NOTE_DIR, `${bot.name}.jsonl`), line + '\n', 'utf8')
      } catch (error) {
        return fail(`写便签失败：${error?.message ?? error}`)
      }
      return ok(
        `已留给 ${bot.name}（不唤醒）。它下次干活时会读到；这条没有占用任何 turn。`,
      )
    },
  })

  tool({
    name: 'bot_notes_read',
    description:
      'Read and clear the notes left for a Bot by bot_note. A Bot calls this at the start of its own turn to pick up reports and broadcasts without them having ever cost a turn.',
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id. Omit to read notes for the calling Bot if resolvable.' },
        keep: { type: 'boolean', description: 'true = do not clear after reading (default false).' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const bot = findBot(state, args.bot)
      if (!bot) return fail(`Unknown Bot: ${args.bot}`)
      const file = join(NOTE_DIR, `${bot.name}.jsonl`)
      let raw = ''
      try { raw = await readFile(file, 'utf8') } catch { return ok(`（${bot.name} 没有待读便签）`) }
      const items = raw.split('\n').filter(l => l.trim() !== '').map(l => {
        try { return JSON.parse(l) } catch { return { at: '', from: null, text: l } }
      })
      if (items.length === 0) return ok(`（${bot.name} 没有待读便签）`)
      if (args.keep !== true) {
        try { await writeFile(file, '', 'utf8') } catch { /* 清不掉就留着，下次再读 */ }
      }
      const lines = items.map((n, i) =>
        `${i + 1}. [${n.at || '?'}]${n.from ? ` ${n.from}：` : ' '}${n.text}`)
      return ok(`${bot.name} 的便签 ${items.length} 条${args.keep === true ? '（未清空）' : '（已清空）'}：\n${lines.join('\n')}`)
    },
  })

  // ── 事件驱动调度器（R25）──────────────────────────────────────────
  // 装在本插件里，不另起插件。理由见 dispatcher.js 头注释：
  // 实测吞吐 = 并发 / (F + P×steps)，批量只值 1.14×，唯一大杠杆是「让空出来的槽立刻被填上」。
  // 触发源用宿主自己的 'api-session/status'（idle/running），频率天然等于吞吐。
  const dispatcherEnabled = !/^(0|false|off)$/i.test(String(process.env.DSH_BOT_DISPATCH ?? 'on'))
  const dispatcher = installDispatcher(ctx, {
    config: {
      // 板目录优先级：插件 config（cordis.patch.yml）> 环境变量 > 通用默认。
      // 不给默认私有路径 —— 这是公开仓库，硬编码本机路径会泄露也会让别人跑不起来。
      boardRoot: (typeof config.boardRoot === 'string' && config.boardRoot.trim() !== '')
        ? config.boardRoot.trim()
        : (process.env.DSH_BOT_BOARD
          ? String(process.env.DSH_BOT_BOARD)
          : join(homedir(), '.dsh-bot', 'board')),
    },
    log: (message) => {
      try { console.error(`[dsh-bot/dispatcher] ${message}`) } catch { /* ignore */ }
    },
    prompt: (sessionId, text) => promptSession(sessionId, text),
    listBots: async () => {
      const state = await loadStateInPlugin()
      return Object.values(state.bots)
        .filter(bot => bot && typeof bot.name === 'string' && typeof bot.sessionId === 'string')
        .map(bot => ({ name: bot.name, sessionId: bot.sessionId, workspace: bot.workspace }))
    },
  })
  if (!dispatcherEnabled) dispatcher.setEnabled(false)
  ctx.effect(() => () => dispatcher.dispose())

  tool({
    name: 'bot_dispatch',
    description:
      'Inspect or drive the event-driven task dispatcher that runs inside this plugin. It wakes an idle Bot only when the task board has work that belongs to it; an empty board costs nothing. Actions: status (default) | tick (force one round now) | on | off.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status (default) | tick | on | off' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const action = String(args.action ?? 'status').toLowerCase()
      if (action === 'on') { dispatcher.setEnabled(true); return ok('调度器已开启。下一次 idle 事件起生效。') }
      if (action === 'off') { dispatcher.setEnabled(false); return ok('调度器已关闭（不再自动唤醒）。') }
      if (action === 'tick') {
        const r = await dispatcher.tick()
        return ok(
          `手动 tick：${r.ok === true ? 'ok' : 'failed'}，唤醒 ${r.wakes ?? 0} 个。\n` +
          `原因：${r.reason}\n` +
          (r.stats ? `板况：${JSON.stringify(r.stats)}` : ''),
        )
      }
      const s = dispatcher.status()
      return ok(
        `调度器 ${s.enabled ? '开启' : '关闭'}\n` +
        `板目录：${s.config.boardRoot}\n` +
        `并发上限：${s.config.maxConcurrent}　单轮最多唤醒：${s.config.maxWakePerRound}\n` +
        `累计 tick：${s.metrics.ticks}　累计唤醒：${s.metrics.wakes}\n` +
        `最近 tick：${s.metrics.lastTickAt ?? '（还没跑过）'}\n` +
        `最近原因：${s.metrics.lastReason || '—'}\n` +
        `跟踪中的会话：${s.busyTracked}（其中在跑 ${s.runningCount}）\n` +
        `失败冷却中：${s.cooldowns}\n` +
        (s.metrics.lastError ? `最近错误：${s.metrics.lastError}` : ''),
      )
    },
  })
}
