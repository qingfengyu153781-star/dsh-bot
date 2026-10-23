/**
 * dispatcher.js —— 事件驱动的任务调度器（装在 @local/dsh-bot 里）
 *
 * ── 为什么是现在这个形状 ──────────────────────────────────────────
 * 实测（2026-10-23，9866 个 turn 拟合）：
 *     turn 时长 W = F + P × steps
 *     F = 35.7s（每轮固定开销）   P = 19.4s（每步）   平均 13.3 步
 *
 * 于是吞吐 = 并发 / W。三个可动的旋钮，实测幅度：
 *     并发 19.5 → 74        3.8×      ← 唯一的大杠杆
 *     每轮吃 m 条（批量）    1.14×     ← 几乎没用，F 只占 12.2%
 *     每轮步数 13.3 → 5      2.6×      ← 但要靠减真实工作量，不是免费
 *
 * **所以不做批量**。批量的理论上界只有 1.14×，而它会拉长单轮，
 * 反过来堵死并发槽 —— 与目标相反。
 *
 * ── 机制 ─────────────────────────────────────────────────────────
 * 宿主已经给了两个现成的信号（已核实）：
 *   · 'api-session/status'(sessionId, running:boolean)  —— 谁刚空出来
 *   · sessionController.list() → SessionSummary.running —— 谁在跑（快照，不唤醒 Agent）
 *   · 'agent/status'({agent, status:'idle'|'running'})  —— 同上，按 Agent 维度
 *
 * 事件频率天然等于吞吐：忙时触发多、闲时触发少、没活时完全不触发。
 * 这正是"压力是动态的"需要的形状 —— 不需要节拍，不需要每轮跑一次。
 *
 * 一次 tick 的全部工作：
 *   1. 读板（几十个小 JSON，<5ms）
 *   2. 算「谁该被叫」（纯函数 dispatcher_core.decide）
 *   3. 对每个该叫的，投一条 40 字门铃
 * 板空 → 立刻返回，零 token。
 */

import { readFileSync, existsSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULTS = {
  // 板目录：优先环境变量，否则用 ~/.dsh-bot/board（通用默认，不含任何私有路径）。
  // 需要指向别处时设 DSH_BOT_BOARD，或在插件 config 里给 boardRoot。
  boardRoot: process.env.DSH_BOT_BOARD || join(homedir(), '.dsh-bot', 'board'),
  maxConcurrent: 60,        // 同时最多多少个 Bot 在跑（保护模型配额）
  maxWakePerRound: 20,      // 单次 tick 最多叫几个
  minRewakeIntervalMs: 8000, // 同一 Bot 两次门铃最小间隔（一次 turn 通常 >30s）
  failureCooldownMs: 60000,
  debounceMs: 250,          // 事件合并窗口
  reconcileMs: 300000,      // 兜底对账（接住可能丢的 fs 事件），不承担吞吐
  doorbell: '',             // 空 = 用默认模板
}

const PRIORITY_W = { critical: 0, high: 1, normal: 2, low: 3 }
const SIZE_W = { small: 0, medium: 1, large: 2 }

// ── 板读取 ──────────────────────────────────────────────────────
function readTasks(boardRoot) {
  const dir = join(boardRoot, 'tasks')
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (t && typeof t.id === 'string') out.push(t)
    } catch { /* 半写文件：跳过，下一轮再来 */ }
  }
  return out
}

function isReady(t, byId) {
  if (!t || t.state !== 'pending') return false
  for (const d of t.deps || []) {
    const dep = byId[d]
    if (!dep || dep.state !== 'done') return false
  }
  return true
}

function leaseExpired(t, now) {
  return t.state === 'claimed' && !!t.leaseUntil && now > Date.parse(t.leaseUntil)
}

function taskKey(t) {
  return [
    PRIORITY_W[t.priority] ?? 2,
    SIZE_W[t.size] ?? 1,
    Date.parse(t.createdAt) || 0,
    t.id,
  ]
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * 纯决策：谁该被唤醒。无 IO、无时钟、可重放。
 * @param {{tasks:Array, bots:Array, now:number, limits:object}} input
 * @returns {{wakes:Array, skipped:object, stats:object, reason:string}}
 */
export function decide(input) {
  const now = input.now ?? Date.now()
  const limits = { ...DEFAULTS, ...(input.limits || {}) }
  const tasks = input.tasks || []
  const bots = input.bots || []
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]))

  const ready = tasks.filter(t => isReady(t, byId)).sort((x, y) => cmp(taskKey(x), taskKey(y)))
  const expired = tasks.filter(t => leaseExpired(t, now))

  const inflight = new Map()
  for (const t of tasks) {
    if (t.state === 'claimed' && t.claimedBy) {
      inflight.set(t.claimedBy, (inflight.get(t.claimedBy) || 0) + 1)
    }
  }

  const running = bots.filter(b => b.status === 'running')
  const idle = bots.filter(b => b.status !== 'running')
  const skipped = { running: [], cooldown: [], failing: [], noWork: [], capped: [] }

  const candidates = []
  for (const b of bots) {
    if (b.status === 'running') { skipped.running.push(b.name); continue }
    if (b.status === 'absent') { skipped.failing.push(b.name); continue }

    const fail = b.failures
    if (fail && fail.count > 0) {
      const backoff = limits.failureCooldownMs * Math.min(2 ** (fail.count - 1), 8)
      if (now < (fail.lastAt || 0) + backoff) { skipped.failing.push(b.name); continue }
    }
    if (now - (b.lastWakeAt || 0) < limits.minRewakeIntervalMs) {
      skipped.cooldown.push(b.name); continue
    }

    const mine = ready.filter(t => t.owner === b.name)
    const mineInflight = inflight.get(b.name) || 0
    if (mine.length === 0 && mineInflight === 0) { skipped.noWork.push(b.name); continue }

    const first = mine[0]
    candidates.push({
      bot: b.name,
      sessionId: b.sessionId,
      readyCount: mine.length,
      inflight: mineInflight,
      score: first ? taskKey(first) : [9, 9, 0, b.name],
      reason: mine.length > 0
        ? `ready=${mine.length} inflight=${mineInflight}`
        : `resume inflight=${mineInflight}`,
    })
  }

  candidates.sort((a, b) => cmp(a.score, b.score) || (a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0))

  const slots = Math.max(0, limits.maxConcurrent - running.length)
  const cap = Math.min(slots, limits.maxWakePerRound)
  const wakes = candidates.slice(0, cap)
  skipped.capped = candidates.slice(cap).map(c => c.bot)

  const unassignedReady = ready.filter(t => !t.owner).length

  return {
    now,
    wakes,
    skipped,
    stats: {
      tasks: tasks.length,
      ready: ready.length,
      unassignedReady,
      expired: expired.length,
      running: running.length,
      idle: idle.length,
      candidates: candidates.length,
      woken: wakes.length,
      slots,
    },
    reason: wakes.length > 0
      ? `唤醒 ${wakes.length}（ready=${ready.length} idle=${idle.length} running=${running.length}）`
      : ready.length === 0
        ? '板上无 ready 任务'
        : candidates.length === 0
          ? '有 ready 但无空闲且属主的 Bot'
          : `并发已满（running=${running.length}/${limits.maxConcurrent}）`,
  }
}

/** 门铃文本：必须 ≤40 字，且不含指令细节（细节在板上）。 */
export function doorbellFor(botName, readyCount, template) {
  if (typeof template === 'string' && template.trim() !== '') {
    return template.replaceAll('{bot}', botName).replaceAll('{n}', String(readyCount))
  }
  // 为什么这么短：这段文本会作为 user 消息进入该 Bot 的下一轮上下文，
  // 每次唤醒都要付一次 token。指令细节（--max-steps、size 分级）已经在该
  // Bot 的记忆里（R24），门铃只负责「敲门 + 说清领到 0 就收工」。
  // 实测过 61 字的版本，被测试挡下：唤醒 100 次/h 就是白烧 6100 字/h。
  return `有活。claim --owner ${botName}；0 就结束本轮。`
}

/**
 * 装调度器。
 * @param {object} ctx  Cordis context
 * @param {object} opts
 *   - prompt(sessionId, text): Promise<void>   投递门铃
 *   - listBots(): Promise<Array<{name,sessionId,workspace}>>   读 Bot 登记
 *   - config: 覆盖 DEFAULTS
 * @returns {{dispose():void, tick():Promise<object>, status():object, setEnabled(b):void}}
 */
export function installDispatcher(ctx, opts) {
  const config = { ...DEFAULTS, ...(opts.config || {}) }
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  // 运行时状态
  const busy = new Map()       // sessionId -> true/false（来自事件 + 快照）
  const lastWake = new Map()   // name -> ts
  const failures = new Map()   // name -> { count, lastAt }
  const metrics = {
    ticks: 0, wakes: 0, skippedTicks: 0,
    lastTickAt: null, lastReason: '', lastError: null, lastStats: null,
  }

  let enabled = true
  let ticking = false
  let pendingAgain = false
  let debounceTimer = null
  let reconcileTimer = null
  let boardWatcher = null
  let disposed = false

  // ── 状态快照：不唤醒 Agent ────────────────────────────────────
  async function refreshBusy() {
    let controller
    try { controller = ctx.get('sessionController') } catch { return }
    if (controller === undefined || typeof controller.list !== 'function') return
    try {
      const ac = new AbortController()
      const res = await controller.list({}, ac.signal)
      for (const row of res?.items ?? []) {
        busy.set(String(row.sessionId), row.running === true)
      }
    } catch (error) {
      log(`list() 失败：${error?.message ?? error}`)
    }
  }

  // ── 单次调度 ────────────────────────────────────────────────
  async function doTick() {
    if (disposed) return { ok: false, reason: 'disposed' }
    if (!enabled) return { ok: false, reason: 'disabled' }

    // 单飞：已有 tick 在跑就只记一个"再来一次"，不并发进
    if (ticking) { pendingAgain = true; return { ok: false, reason: 'busy' } }
    ticking = true
    metrics.ticks++
    metrics.lastTickAt = new Date().toISOString()

    try {
      const tasks = readTasks(config.boardRoot)
      if (tasks.length === 0) {
        metrics.lastReason = '板上无任务'
        metrics.lastStats = { tasks: 0 }
        return { ok: true, wakes: 0, reason: '板上无任务' }
      }

      let bots = []
      try { bots = (await opts.listBots()) || [] } catch (error) {
        metrics.lastError = String(error?.message ?? error)
        return { ok: false, reason: `读 Bot 登记失败：${metrics.lastError}` }
      }
      if (bots.length === 0) return { ok: true, wakes: 0, reason: '没有登记的 Bot' }

      // 每轮都刷新一次快照，避免只靠事件导致状态漂移
      await refreshBusy()

      const enriched = bots.map(b => {
        const sid = String(b.sessionId)
        const live = busy.get(sid)
        return {
          name: b.name,
          sessionId: sid,
          // 快照里有就以它为准；没有就当 idle（宁可多叫一次，不饿死）
          status: live === true ? 'running' : 'idle',
          lastWakeAt: lastWake.get(b.name) || 0,
          failures: failures.get(b.name) || null,
        }
      })

      const result = decide({ tasks, bots: enriched, now: Date.now(), limits: config })
      metrics.lastReason = result.reason
      metrics.lastStats = result.stats

      // 只叫前若干个，失败立刻降级
      for (const w of result.wakes) {
        try {
          await opts.prompt(w.sessionId, doorbellFor(w.bot, w.readyCount, config.doorbell))
          lastWake.set(w.bot, Date.now())
          failures.delete(w.bot)
          metrics.wakes++
        } catch (error) {
          const prev = failures.get(w.bot) || { count: 0, lastAt: 0 }
          failures.set(w.bot, { count: prev.count + 1, lastAt: Date.now() })
          log(`唤醒 ${w.bot} 失败：${error?.message ?? error}`)
        }
      }

      return { ok: true, wakes: result.wakes.length, reason: result.reason, stats: result.stats }
    } catch (error) {
      metrics.lastError = String(error?.message ?? error)
      return { ok: false, reason: metrics.lastError }
    } finally {
      ticking = false
      if (pendingAgain) {
        pendingAgain = false
        // 下一拍再来；用 setTimeout(0) 让出事件循环，避免深递归
        setTimeout(() => { void tick() }, 0)
      }
    }
  }

  // ── 去抖触发 ────────────────────────────────────────────────
  function scheduleTick(why) {
    if (disposed || !enabled) return
    if (debounceTimer !== null) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void doTick().catch(error => log(`tick 异常：${error?.message ?? error}`))
    }, config.debounceMs)
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref()
  }

  function tick() { return doTick() }

  // ── 事件订阅 ────────────────────────────────────────────────
  const offs = []

  function on(name, handler) {
    try {
      const off = ctx.on(name, handler)
      if (typeof off === 'function') offs.push(off)
    } catch (error) {
      log(`订阅 ${name} 失败：${error?.message ?? error}`)
    }
  }

  // 会话运行状态变化：这是最精确的"槽空出来"信号
  on('api-session/status', (sessionId, running) => {
    busy.set(String(sessionId), running === true)
    if (running !== true) scheduleTick('api-session/status: idle')
  })

  // Agent 维度（冗余一份，宿主版本差异时仍能工作）
  on('agent/status', payload => {
    const id = payload && payload.agent && payload.agent.id
    if (id === undefined) return
    const isRunning = payload.status === 'running'
    busy.set(String(id), isRunning)
    if (!isRunning) scheduleTick('agent/status: idle')
  })

  // 板上出现新活：给写入方一个即时入口
  try {
    const tasksDir = join(config.boardRoot, 'tasks')
    if (existsSync(tasksDir)) {
      boardWatcher = watch(tasksDir, { persistent: false }, () => scheduleTick('board: change'))
      if (typeof boardWatcher.unref === 'function') boardWatcher.unref()
    }
  } catch (error) {
    log(`watch 板上目录失败（不影响事件驱动）：${error?.message ?? error}`)
  }

  // 兜底对账：只接住丢的事件，不承担吞吐
  if (config.reconcileMs > 0) {
    reconcileTimer = setInterval(() => { void refreshBusy().then(() => scheduleTick('reconcile')) }, config.reconcileMs)
    if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
  }

  // 启动后先来一次（等宿主把 Agent 表建好）
  setTimeout(() => scheduleTick('startup'), 3000)

  return {
    tick,
    status() {
      return {
        enabled,
        config: {
          boardRoot: config.boardRoot,
          maxConcurrent: config.maxConcurrent,
          maxWakePerRound: config.maxWakePerRound,
        },
        metrics: { ...metrics },
        busyTracked: busy.size,
        runningCount: [...busy.values()].filter(Boolean).length,
        cooldowns: failures.size,
      }
    },
    setEnabled(next) {
      enabled = next === true
      if (enabled) scheduleTick('enabled')
      return enabled
    },
    dispose() {
      disposed = true
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null }
      if (reconcileTimer !== null) { clearInterval(reconcileTimer); reconcileTimer = null }
      try { if (boardWatcher) boardWatcher.close() } catch { /* ignore */ }
      for (const off of offs) { try { off() } catch { /* ignore */ } }
    },
  }
}

export { DEFAULTS, taskKey, isReady, leaseExpired }
