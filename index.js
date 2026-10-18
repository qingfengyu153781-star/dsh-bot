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
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = '@local/dsh-bot'
export const inject = ['tools']

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const STATE_DIR = join(HOME, 'bot-ours')
const STATE_PATH = join(STATE_DIR, 'state.json')

const EMPTY_STATE = { version: 2, bots: {}, groups: {} }

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
 * 路径里的控制字符闸（实测：`D:\myproject` 被写成单反斜杠后，
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
        `例如 "D:\\myproject" 会被解析成 \\a、\\b）。请写成 "D:\\\\myproject" 或改用 /。`,
    )
  }
  return text
}

function findBot(state, key) {
  if (!key) return undefined
  const byName = Object.values(state.bots).find(bot => bot.name === key)
  return byName ?? state.bots[key]
}

function findGroup(state, key) {
  if (!key) return undefined
  const byName = Object.values(state.groups).find(group => group.name === key)
  return byName ?? state.groups[key]
}

function callerBot(state, exec) {
  const sessionId = exec && exec.agent ? exec.agent.id : undefined
  if (!sessionId) return undefined
  return Object.values(state.bots).find(bot => bot.sessionId === sessionId)
}

function briefBot(bot) {
  const bits = [bot.main === true ? `[主] ${bot.name}` : bot.name]
  if (bot.role) bits.push(`(${bot.role})`)
  bits.push(`workspace=${bot.workspace}`)
  if (bot.sessionId) bits.push(`session=${bot.sessionId}`)
  return bits.join(' ')
}

export function apply(ctx) {
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
          await setGroupMode(state, group, next)
          return {
            kind: 'success',
            text:
              next === 'round-robin'
                ? `群「${group.name}」已切到轮流发言：每个成员依次发言，后一位能看到前一位的话。`
                : `群「${group.name}」已切回广播：只有群会话自己的 agent 会回。`,
          }
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
   */
  async function waitForReply(sessionId, sinceSeq, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let text = ''
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      let events
      try {
        const info = await controller().inspect(sessionId)
        events = info.events ?? []
      } catch {
        continue
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
      if (parts.length > 0) text = parts.join('\n').trim()
      if (ended) return text
    }
    return text
  }

  /** 群模式：broadcast（默认，投给群会话）/ round-robin（成员依次发言）。 */
  function normalizeGroupMode(value) {
    return value === 'round-robin' ? 'round-robin' : 'broadcast'
  }

  async function setGroupMode(state, group, mode) {
    group.mode = normalizeGroupMode(mode)
    await saveState(state)
    return group.mode
  }

  /** 群聊的共享记录：一条一条追加，超过 300 条裁掉最旧的（会话日志仍是真相源）。 */
  function appendLog(group, entry) {
    if (!Array.isArray(group.log)) group.log = []
    group.log.push(entry)
    if (group.log.length > 300) group.log = group.log.slice(-300)
    return entry
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
      assertUsablePath(args.workspace, 'workspace')
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
        bot: { type: 'string', description: 'Bot name or id.' },
        text: { type: 'string', description: 'Message to deliver.' },
      },
      required: ['bot', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const bot = findBot(state, args.bot)
      if (!bot) return fail(`Unknown Bot: ${args.bot}`)
      await promptSession(bot.sessionId, args.text)
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
      if (wake === 'ready') {
        return ok(`已投递并且已唤醒：${bot.name}（session ${bot.sessionId}）会在这个会话里回复。`)
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
        mode: { type: 'string', enum: ['broadcast', 'round-robin'], description: 'broadcast（默认，只有群会话自己回）或 round-robin（成员轮流发言，后者能看到前者）。' },
      },
      required: ['name', 'workspace'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args, exec) {
      assertUsablePath(args.workspace, 'workspace')
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
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: String(v.text) }] },
    async execute(args) {
      const state = await loadStateInPlugin()
      const group = findGroup(state, args.group)
      if (!group) return fail(`Unknown group: ${args.group}`)
      const mode = group.mode === 'round-robin' ? 'round-robin' : 'broadcast'
      if (mode === 'broadcast') {
        const prefix = args.from ? `[${args.from}] ` : ''
        await promptSession(group.sessionId, `${prefix}${args.text}`)
        return ok(`Posted to ${group.name} (session ${group.sessionId})，模式 broadcast（只有群会话自己的 agent 会回）。`)
      }

      // ── 轮流发言（对齐 ds-bot 的做法）─────────────────────────────
      // 群聊是**一条共享的有序对话**：每条发言都进同一个 room log；
      // 每位成员收到的 prompt 里带上「本轮之前的上下文」与「本轮已发言的部分」，
      // 并被告知自己是第几个、前/后各有几个人 —— 这样才是在同一个群里接话，
      // 而不是把同一句话挨个私聊一遍。
      const members = (group.members ?? [])
        .map(id => state.bots[id] ?? Object.values(state.bots).find(bot => bot.sessionId === id))
        .filter(Boolean)
      const admin = members.find(bot => bot.id === group.admin) ?? members[0]
      const order = admin === undefined ? members : [admin, ...members.filter(bot => bot.id !== admin.id)]
      const log = Array.isArray(group.log) ? group.log : []
      const roundStart = log.length
      appendLog(group, { seq: log.length + 1, who: args.from || '用户', role: 'user', text: args.text, time: Date.now() })
      if (order.length === 0) {
        await saveState(state)
        return ok(`群 ${group.name} 没有可用的成员 Bot；这条消息只记进了群记录。`)
      }
      const replies = []
      for (let index = 0; index < order.length; index += 1) {
        const member = order[index]
        const earlier = log.slice(Math.max(0, roundStart - 8), roundStart)
        const current = log.slice(roundStart)
        const lines = []
        lines.push(`你是「${group.name}」这个群聊的成员：${member.name}。群成员：${order.map(bot => bot.name).join('、')}。`)
        lines.push('成员一次只一个人说话，每条发言都会先发到群里，下一位才开口。不要重复别人已经说过的内容。')
        if (earlier.length > 0) {
          lines.push(`【本轮之前的上下文，仅供参考】\n${earlier.map(line => `${line.who}：${line.text}`).join('\n')}`)
        }
        lines.push(`【本轮到目前为止（从旧到新）】\n${current.map(line => `${line.who}：${line.text}`).join('\n')}`)
        lines.push(`本轮发言顺序：${order.map(bot => bot.name).join(' → ')}。`)
        lines.push(`你是第 ${index + 1} / ${order.length} 位：你之前有 ${index} 位发过言，之后还有 ${order.length - index - 1} 位会看到你的发言。`)
        lines.push('直接说你这一轮要说的内容，不要加名字前缀；如果确实没有要补充的，只回 [PASS]。')
        const since = await lastSeq(member.sessionId)
        await promptSession(member.sessionId, lines.join('\n\n'))
        const reply = (await waitForReply(member.sessionId, since, 90_000)).trim()
        if (reply === '' || /^\[PASS\]$/i.test(reply)) {
          appendLog(group, { seq: log.length + 1, who: member.name, role: 'pass', text: '(未发言)', time: Date.now() })
          replies.push(`${member.name}：(未发言)`)
          continue
        }
        appendLog(group, { seq: log.length + 1, who: member.name, role: 'bot', text: reply, time: Date.now() })
        replies.push(`${member.name}：${reply}`)
      }
      group.rounds = (typeof group.rounds === 'number' ? group.rounds : 0) + 1
      await saveState(state)
      return ok(`群「${group.name}」本轮结束（${order.length} 位成员，顺序 ${order.map(bot => bot.name).join(' → ')}）：\n\n${replies.join('\n\n')}`)
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
        mode: { type: 'string', enum: ['broadcast', 'round-robin'], description: 'broadcast = 只有群会话自己回；round-robin = 成员轮流发言。' },
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
      const mode = await setGroupMode(state, group, args.mode)
      return ok(`群「${group.name}」发言模式已设为 ${mode}${mode === 'round-robin' ? '（成员依次发言，后者能看到前者）' : '（只有群会话自己回）'}。`)
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
      // 群聊优先读**共享记录**（group.log）：那是所有成员看到的那一条有序对话。
      if (group && Array.isArray(group.log) && group.log.length > 0) {
        const tailLog = group.log.slice(-limit)
        const head = `群「${group.name}」· 模式 ${normalizeGroupMode(group.mode)} · 共 ${group.log.length} 条`
        return ok([head, ...tailLog.map(line => `${line.who}：${line.text}`)].join('\n'))
      }
      const inspection = await controller().inspect(sessionId)
      // 会话日志里两类事件的形状不同：
      //   user/message      -> data.content            （直接挂 content）
      //   assistant/message -> data.message.content    （包在 message 里）
      // 早先只读 data.message.content，导致群聊里 85 条用户侧消息全被判"没有消息"。
      const NOISE = ['Current runtime context', '<system-reminder>', '<attention_orchestration', 'Repeated tool call detected']
      const rows = []
      for (const event of inspection.events ?? []) {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        const parts = event.data?.message?.content ?? event.data?.content ?? []
        const text = parts.filter(part => part && part.type === 'text').map(part => part.text).join('').trim()
        if (text === '') continue
        if (NOISE.some(prefix => text.startsWith(prefix))) continue
        rows.push(`${event.type === 'user/message' ? 'User' : 'Assistant'}: ${text}`)
      }
      const tail = rows.slice(-limit)
      if (tail.length === 0) {
        // 另一会话实测：消息刚发、事件还没落盘时读会得到空。这里给出可判的说明而不是假装"没有消息"。
        const events = inspection.events ?? []
        const lastTime = events.reduce((max, event) => (typeof event.time === 'number' && event.time > max ? event.time : max), 0)
        const ageMs = lastTime > 0 ? Date.now() - lastTime : null
        if (ageMs !== null && ageMs < 10000) {
          return ok(`（暂无已落盘的可读消息：该会话最后一次活动在 ${Math.round(ageMs / 1000)} 秒前，事件可能还没写完，稍后再读一次）`)
        }
        return ok(`(no messages in ${sessionId})`)
      }
      return ok(tail.join('\n\n'))
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
    name: 'memory_remember',
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
    async execute(args) {
      assertUsablePath(args.workspace, 'workspace')
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
    name: 'memory_recall',
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
}
