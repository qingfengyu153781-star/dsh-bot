# 更新报告 · @local/dsh-bot 0.5.0（2026-10-23）

相对 0.4.0，一句话：**把「谁来唤醒空闲 Bot」这件事从人手上拿走，装进插件本身。**

## 一、为什么不是「每轮跑一次」，也不是定时

用户的两条硬要求：**每轮跑一次太耗时间**、**定时没用（压力是动态的）**。

两条都对。先量清楚再改：

| 量 | 实测值 | 来源 |
|---|---|---|
| turn 数 | 9,866 | `~/.dsh/sessions` 全部会话日志 |
| 平均 steps | 13.3 | 同上 |
| 平均 turn 时长 | 293.5s | 同上 |
| **F（每轮固定开销）** | **35.7s** | 最小二乘拟合 `W = F + P × steps` |
| **P（每步成本）** | **19.4s** | 同上 |
| 固定开销占比 | **12.2%** | `F / 平均时长` |

结论直接推翻了「批量领取」：

```
吞吐 = 并发 × 3600 / W，其中 W = F + P × steps
每轮吃 m 条 → steps 涨 m 倍 → W 涨 m 倍 → 产能只有 1.14× 上界
```

| 每轮吃 m 条 | 单轮时长 | 19.5 并发产能 | 相对 m=1 |
|---|---|---|---|
| 1 | 293s | 239 条/h | 1.00× |
| 5 | 1,324s | 265 条/h | **1.11×** |
| 20 | 5,190s | 271 条/h | 1.13× |
| ∞ | — | 272 条/h | **1.14×（上界）** |

**F 只占 12.2%，所以摊薄固定开销几乎没有收益。** 上一版把「批量 ×5」当成主杠杆是错的，
而且它会拉长单轮、反过来堵死并发槽 —— 与目标相反。

真正的杠杆只有一个：**并发**。19.5 → 74 是 3.8×。

## 二、所以机制是：让空出来的槽立刻被填上

用宿主自己的信号，不自己造节拍：

| 信号 | 签名（已核实） | 用途 |
|---|---|---|
| `api-session/status` | `(sessionId, running: boolean)` | 谁刚空出来 —— **频率天然等于吞吐** |
| `agent/status` | `({ agent, status: 'idle' \| 'running' })` | 同上，Agent 维度（冗余一份） |
| `sessionController.list()` | → `SessionSummary.running` | 快照，**不唤醒 Agent** |
| `fs.watch` 板上目录 | — | 板上出现新活时立刻填 |

忙时触发多、闲时触发少、**板空时完全不触发（零 token）**。这就是「压力是动态的」的正解。

```
idle 事件 ─┐
板上变化 ──┼→ 去抖 250ms → 调度一轮（单飞，不重入）
running ───┘        ↓
              读板（几十个小 JSON，<5ms）
                    ↓
            只叫「有 ready 且自己空闲」的
            板空 → 立刻返回
```

兜底：5 分钟一次对账，只接住可能丢的 fs 事件（实测 `fs.watch` 在 20 并发写入下只报 8/20 个文件名）。
它不承担吞吐，性质是被动重放，不是调度节拍。

## 三、新增工具

| 工具 | 作用 |
|---|---|
| `bot_dispatch` | `status` / `tick` / `on` / `off` —— 看调度器状态、手动推一轮、开关 |
| `bot_note` | **不唤醒**地给某个 Bot 留话（汇报、抄送、规则广播） |
| `bot_notes_read` | 读并清空自己的便签 |

`bot_note` 解决的是**需求侧**：一条汇报消息占掉一个 turn，就是占掉 293.5s 的并发槽。
实测 9,866 个 turn 里这类消息占大头（旧统计：汇报 31.7% + 派活 31.5% + 规则广播 30.8%）。
把它们降级成一次文件追加，不建 turn、不花模型调用。

## 四、安全默认

| 项 | 默认 | 改法 |
|---|---|---|
| 调度器开关 | **开** | `DSH_BOT_DISPATCH=off` 或 `bot_dispatch {action:"off"}` |
| 板目录 | `~/.dsh-bot/board` | 插件 config 的 `boardRoot`，或 `DSH_BOT_BOARD=<路径>` |
| 并发上限 | 60 | `dispatcher.js` 的 `DEFAULTS.maxConcurrent` |
| 单轮最多唤醒 | 20 | `DEFAULTS.maxWakePerRound` |
| 同一 Bot 最小间隔 | 8s | `DEFAULTS.minRewakeIntervalMs` |

失败退避：连续失败按 `60s × 2^(n-1)`（封顶 8 倍）冷却，不会打爆宿主。

## 五、测试

本地跑过的测试（**测试文件不入库**，见 §六）：

| 测试 | 结果 |
|---|---|
| `test/dispatcher.test.mjs` | **27 / 27** |
| `test/plugin.test.mjs` | **9 / 9** |
| `test/group_queue.test.mjs` | **11 / 11**（原有，未回归） |
| `test/verify_boardroot.mjs` | **7 / 7**（板目录优先级） |

合计 **54 项全绿**。

测试里挡下过一个真违规：门铃初版 61 字，超过 R23 的 40 字上限。
按 100 次唤醒/h 算，那等于白烧 6,100 字/h 上下文 —— 已改成 33 字。

⚠ 为什么测试不入库：测试里会带本机路径与真实工作区名，入库等于把使用者的
目录结构写进公开仓库。需要时在本地按同口径复跑即可。

## 六、配置项变化（含脱敏）

### 板目录不再硬编码

`dispatcher.js` 的 `boardRoot` 原来写死成一个本机绝对路径。这对公开仓库有两个问题：
**泄露使用者的目录结构**，且**别人 clone 下来跑不起来**。

现在改成三级优先级，默认值是通用路径：

```
插件 config 的 boardRoot  >  环境变量 DSH_BOT_BOARD  >  ~/.dsh-bot/board
```

```jsonc
// <profile>/cordis.patch.yml —— 指定你自己的板目录
- id: bot-ours
  name: "@local/dsh-bot"
  config:
    boardRoot: "<你的任务板路径>"
```

同理 `tools/check-sync.ps1` / `tools/sync-mirror.ps1` 的镜像目录也去掉了硬编码：
改成 `-MirrorDir` 参数或 `DSH_BOT_MIRROR` 环境变量。未指定时 `check-sync` 跳过镜像校验
（镜像只是第三处对照，不是必需品）。

### 文档与示例已脱敏

仓库里的示例路径、Bot 名示例统一换成通用写法（如 `core-3 → team-core-3`），
不含任何使用者的真实项目名、角色名或绝对路径。

### 仓库不含测试

`test/` 已加入 `.gitignore`。测试在本地跑（本次 54 项全绿），不作为发布内容。
原因：测试文件里带本机路径与真实工作区名，入库等于把使用者的目录结构写进公开仓库。

---

## 七、升级注意

```powershell
pwsh -File tools/sync-installed.ps1    # 同步 index.js + dispatcher.js + package.json
pwsh -File tools/check-sync.ps1        # 校验，必须输出「一致」
```

然后**重启 DSH** 才加载。

⚠ `sync-installed.ps1` 以前只同步 `index.js`。加了 `dispatcher.js` 之后，
只同步主文件会让运行时缺依赖，插件会整行加载失败。现在按清单逐文件同步 + 逐文件校验。

⚠ 实测踩过一次：源码加了 `bot_note`，但同步是在加之前跑的，运行时仍是旧版 ——
行为上完全看不出来（工具只是不存在）。所以 `check-sync.ps1` 应该在**任何行为验证之前**先跑。

⚠ 升级后**务必确认板目录**：如果你之前依赖旧的硬编码路径，升级后需要在
`cordis.patch.yml` 里显式配 `boardRoot`，否则会落到 `~/.dsh-bot/board`。

---

# 更新报告 · @local/dsh-bot 0.4.0（2026-10-18 晚）

相对 0.3.0，三件事：**并发放开**、**群成员按「群 × Bot」彻底隔离**、**状态读写性能**。

## 一、群成员隔离（根治）

之前成员在群里发言用的是它自己的**私聊会话**，于是两个问题同时存在：

1. 私聊里的工作线会被带进群（实测有成员把别的工作线整段贴进群讨论）；
2. 群里的发言又写回私聊，污染私聊上下文。

现在每个 **Bot × 每个群** 分到：

| 资源 | 位置 |
|---|---|
| 专属分支会话 | 会话列表里的 `[群] 群名 · Bot名`（首次发言时自动创建，会话丢失会自动重建） |
| 专属记忆文件 | `<workspace>/.dsh-bot/groups/<群名>/<Bot名>.md` |

- 群内 prompt 只带「你在本群的专属记忆」+「本轮之前的群记录」，**不带私聊历史**；
- 每轮发言后自动往自己的记忆文件追加一条（`[第 N 轮] 议题 → 回应前 300 字`）；
- 私聊 `bot_message` 与工作区记忆完全不受群影响。

实测：一个 8 人生产群，8 位成员各自生成 8 个 `.md`（一人一份，文件名即成员名），首轮读完各自文件均回答「0 条，只有标题行」——因为本轮条目在回答之后才写入，边界行为正确。

## 二、并发放开

| 项 | 之前 | 现在 |
|---|---|---|
| `parallel` 并发 | 固定 8 路 | **默认无上限**（`Promise.all` 全发）；需要限流时传 `group_post { concurrency: N }` |
| 不同群之间 | 已并行 | 不变（同群仍串行防两轮互相穿插） |

实测：同一个 8 人群，无上限并发下 **8 条发言完成时间落在 87 毫秒内**，总耗时约 28.7 秒（等于最慢那一位，而不是 8 位相加）；宿主内存 1,424 MB。

## 三、状态读写性能

| 旧行为 | 问题 | 现在 |
|---|---|---|
| 每条发言 `load → save` 整份 `state.json` | Bot/群一多就是 I/O 风暴 | **内存缓存 + 150ms 合并写**（只写最新快照） |
| 每次读状态都重新解析文件 | 并发读互相拖慢 | 进程内缓存，文件 `mtime` 变了才重读（外部手改仍生效） |
| 等回复固定 1.5 秒轮询 | 成员 2 秒答完也要等边界 | **自适应**：前 5 秒 300ms，之后 900ms |

## 四、升级注意

- 已安装副本需要同步一次：`pwsh -File tools/sync-installed.ps1`；
- 首次在某个群发言会自动创建该群成员的**分支会话**（每成员一条），这是预期行为；
- 群记忆文件按「群名/Bot名」存放，换群名会生成新目录。

---

# 更新报告 · @local/dsh-bot 0.3.0（2026-10-18）

按缺陷清单一次性补齐，全部落在 `index.js`。相对 0.2.0：

## 新增

| 能力 | 说明 |
|---|---|
| **`parallel` 群模式** | 同一议题一次发给全部成员，`Promise.all` 并发等待（每人 120 秒），互不阻塞；每人只拿到「本轮之前的上下文」，看不到本轮其他人的发言 |
| **`group_post.members`** | 可选成员子集与顺序（名字或 id 数组）：`members:["审计-基","反方-审计"]` 就只叫这两个人，并按此顺序发言；省略则是默认顺序（admin 先） |
| **每轮自动留档** | 每轮结束追加写 `<workspace>/讨论/群聊记录_<群名>.md`（轮次 + 时间戳 + 每条发言） |
| **失败原因 + 重试一次** | 成员空回复或 `[PASS]` 时重试一次（≤60 秒）；仍失败则记「(未发言：重试一次仍超时/无回应)」这类可判原因，不再只有一句「(未发言)」 |
| **`tools/sync-installed.ps1`** | 源码 → 已装副本的同步脚本，打印前后哈希并校验一致（治"两边各改一份互相覆盖"） |

## 修掉

| # | 症状 | 修法 |
|---|---|---|
| 1 | 不支持的群模式被**静默降级**成 `broadcast`，还回一句"已设为 broadcast" | `normalizeGroupMode` 对未知识别值直接抛错，并列出可选值；`group_set_mode` / `group_create` 的 enum 同步为三项 |
| 2 | `bot_message` 描述写 `message`、实现只认 `text`，按描述传参报 `Cannot read properties of undefined` | 参数加 `message` 别名、`required` 收窄为 `['bot']`，实现取 `args.text ?? args.message`，并校验非空 |

## 已知未做（需要动宿主或另有取舍）

- **"群分支会话"绑定**：本插件的成员发言直接走该 Bot 自己的会话，不会新建「X · 群名」分支会话。若希望每个 Bot 在每个群里有一份独立分支会话，需要在 `resolveGroupOrder` 落库时按「Bot + 群」解析并缓存分支 sessionId —— 属于设计取舍，未在本笔改动。
- **GUI 逐条渲染**：发言用 `session.append('user/message', …, {surfaceOp:'append'})` 写入会话事件，`group_read` 与事件流都能读到；若某个前端版本仍不渲染，需要客户端插件（不是宿主事件类型的问题）。

---

# 修复 · 群聊并发/日志一致性（2026-10-18 生产群压测）

生产群 8 人 round-robin 压测中实测到三个问题，本笔修复：

1. **同群并发 `group_post` 互相穿插**：两轮同时运行，成员收到两份「本轮上下文」；
   `state.json` 整对象 last-writer-wins，导致其中一轮 `group.log` 整体丢失。
   → 按群 id 加串行队列（`serializeGroup`）：同群排队，轮内不会再有第二份快照。
2. **跨群/跨工具状态覆盖**：所有写状态仍是 load 一次、轮末 save 一次。
   → 每次落一条改走短事务（`mutateState`: load→append→save，`serializeState` 串行），
     轮次不再持有开轮快照。
3. **`group.log` 的 `seq` 整轮都是 1**：`group.log` 为空时，调用方用的是另一个局部空数组的
   length。→ `appendLog` 统一按「上一条 seq + 1」生成。
4. **`group_read` 只读 `group.log`**：日志一丢，就把另一轮的可见发言整体藏掉。
   → 会话事件为真相源、优先读会话；`group.log` 仅作兜底，并在不一致时明示。

验证：`test/group_queue.test.mjs`（11 项）——同群两轮并发（log 6/seq 1..6/rounds 2）、
跨群并发（两群各 3 条）、`group_read` 在 log 落后时仍能读出会话里的两轮。
对 HEAD 旧版跑同一用例：4 项红（log=3、seq=[1,1,1]、rounds=1、跨群 G1 log=0）。

# 更新报告 · @local/dsh-bot 0.2.0（2026-10-18）

上一版公开时只有 12 个工具、群聊是"广播式"。这一版补上了**真正的群讨论**和几处会让功能静默失效的缺陷。

## 一、新增

### 1. 群聊两种发言模式

| 模式 | 行为 |
|---|---|
| `broadcast`（默认） | 消息投给群会话，只有群会话自己的 agent 回 |
| `round-robin`（轮流发言） | 成员按顺序依次发言：后一位的 prompt 里带「本轮之前的上下文」+「本轮到目前为止」+「你是第 i / n 位」 |

入口三处：

```
工具：group_set_mode { group:"…", mode:"round-robin" }
命令：在群对话里 / → groupmode   （执行一次切换，再执行一次切回）
建群：group_create { …, mode:"round-robin" }
```

设计对齐了同类实现的核心：**一个群就是一条共享的有序对话**，每条发言都进同一份记录（`group.log`，最多保留 300 条），而不是把同一句话挨个私聊一遍。成员无话可说时回 `[PASS]`，记录里记为「(未发言)」。

### 2. 群讨论在会话里逐条可见

每条发言用宿主自己的写法写进群会话事件流：

```js
agent.session.append('user/message', { id, role: 'user', content: [{ type: 'text', text: `${who}：${text}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
```

- 一句一条消息，按时间顺序排列，GUI 里打开群会话就能看到；
- 不额外调用模型。

### 3. `/main` 可以就地收养当前会话

在任意对话里执行 `main`：该会话还不是 Bot 时，就地登记（`id` = 该会话 id，名字取会话标题或目录名），并设为该工作区的主 Bot；已是 Bot 时切换主位。角色 Bot 执行会被拒绝。

### 4. 斜杠命令一览

```
main         ★ 把这个对话登记为 Bot 并设为主 Bot（已是 Bot 时：再执行一次＝取消）
groupmode    ★ 切换本群发言模式：轮流发言（成员互相看见）/ 广播
```

## 二、修掉的缺陷

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `bot_create` 必抛 `ReferenceError: workspaceId is not defined` | 建 Bot 时引用了 `createSession()` 内部才有的局部变量 | 显式 `const workspaceId = await ensureWorkspace(...)` |
| 2 | 建会话报 `session.create accepts workspaceId or cwd, not both` | 三条创建路径同时传了两个参数 | 统一走 `createSession()`，只传一个 |
| 3 | 群里"投递成功但没人回" | 目标会话在归档集里，宿主的 `ArchivedSessionGate` 对每一步直接 `reject`，轮次以 `blocked` 结束、模型一次请求都不发 | 投递/建会话前 `unarchiveSession` |
| 4 | 同上，修了仍不回 | `unarchiveSession` 收的是**字符串**，代码传了对象，异常被 `catch {}` 吞掉 ⇒ 静默失效 | 改成 `unarchiveSession(sessionId)` |
| 5 | 成员明明回了，工具报「(未发言)」 | `turn/end` 先于 `assistant/message` 落盘，一看到 turn/end 就返回 | turn/end 之后补读最多 4 次（约 6 秒） |
| 6 | `agent.inject` 写进去的内容 GUI 看不见 | inject 只产生 `agent/inbox/spliced`，不产生 `user/message` | 改用 `session.append('user/message', …)` |
| 7 | 路径写错（单反斜杠）会悄悄建出怪目录 | `\a`/`\b` 被解析成控制字符 | 5 个入口加控制字符闸并给出正确写法 |
| 8 | `session_probe` 的 page 恒报 `past cursor` | `throughSeq` 传了 `MAX_SAFE_INTEGER`，宿主要求 ≤ 当前 cursor | 取 `projections.asOfSeq` 当上界 |
| 9 | 手工登记缺 `workspaceId` 的 Bot 残缺 | 旧记录没有该字段 | 读取时按 workspace 路径回填（只补字段，不删条目） |
| 10 | 诊断信息污染数据文件 | `repairs` 被写进 `state.json` | 落盘前剥离，只在本次读取里存在 |
| 11 | 角色 Bot 可以自封主位 / 建群 / 重排工作区 | 命令与工具没有 caller 检查 | 三处补拒绝；同区多个主位读取时归一 |

## 三、验证（本次核验的读数）

```
node --check index.js                         → exit 0
源码与已装副本同哈希                            → True
仓库隐私扫描（用户名路径 / 会话 id / 令牌 / 项目名） → 0 命中
bot_list                                      → 3 个工作区、Bot 与群聊登记完整
双人轮次（round-robin）                         → 后一位引用前一位原话，输出含「第 2/2 位」
群会话事件                                    → 每条发言一条 user/message（seq 连续）
```

## 四、已知限制

- 命令名只能是 ASCII：宿主要求命令名非中文，所以是 `main` / `groupmode`，中文只出现在描述行。
- 会话角色只有 user / assistant 两种，子 Bot 的发言以「名字：内容」形式出现；要做带头像的群界面需要额外的客户端插件。
- 仅在 Windows 上验证；WSL / Linux 未测（代码按 Windows 路径语义编写）。
- `round-robin` 每位成员最长等 90 秒，超时记为「(未回应)」并继续下一位。

## 五、安全说明

本仓库只含插件本体：不含本机会话记录、用户目录路径、项目名或任何凭据。`state.json`（Bot 与群聊登记）与各工作区记忆都在用户本机，不随仓库发布。
