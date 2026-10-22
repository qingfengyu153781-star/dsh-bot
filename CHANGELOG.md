# 更新报告 · @local/dsh-bot 0.4.2（2026-10-22）

新增 **Bot 专属记忆（bot-memory）**：不同的 Bot 拿到不同的记忆。

## 一、为什么

0.4.1 的 ws-index 是**工作区级**——同一个工作区里所有会话（主 Bot、各角色 Bot、用户自己）拿到的是同一份索引。
但 Bot 是分工的：侦察有侦察的线索，实施有实施的进度，审计有审计的疑点。
让它们共用一份记忆，等于把三条工作线搅在一起。

## 二、怎么分

| 层 | 文件 | 谁看得到 |
|---|---|---|
| ws-index | `<workspace>/.dsh-bot/WS_INDEX.md` | 该工作区**所有会话** |
| **bot-memory** | `<workspace>/.dsh-bot/bots/<bot名>.md` | **只有这个 Bot 自己的会话** |

Bot 会话里注入「工作区块 + 自己那块」；用户会话只有工作区块，看不到任何 Bot 的私有记忆。

**归属判定**与 `callerBot()` 同口径：`bot.sessionId`（当前主会话）、`bot.history[]`（`bot_open` 旧会话）、
`group.branches[botId].sessionId`（群分支会话）。同一个 Bot 换过几次会话，记忆都跟着它走。

## 三、顺带把 instructions 接上了

`bot.instructions` 此前只存在登记里，**从没进过提示词**（0.4.1 README 的「边界」里写着这条）。
现在作为「你的常驻指令」注入该 Bot 自己的会话，角色人设终于生效。

## 四、新增两个工具

| 工具 | 作用 |
|---|---|
| `bot_memory_show` | 只读回显某个 Bot 的注入块；省略 `bot` 参数则按调用会话反查（用户会话会被拒） |
| `bot_memory_set` | 写/追加某个 Bot 的专属记忆；走工作区闸，返回里明确「只有这个 Bot 看得到」 |

## 五、实现要点

- `systemPrompt.context` 的 `text()` 必须**同步**，所以单独做了一次同步读 `state.json`（按 mtime 缓存），
  与 `callerBot()` 的异步路径分开，避免把 `await` 引进每轮装配。
- 读失败 / state 缺失 / 会话认不出 → 一律**不抛**，最差只是没有 Bot 块。
- Bot 的工作区以**登记**为准（cwd 可能被 `cd` 走）。

## 六、测试

```sh
node test/test_bot_memory.mjs      # 25 项
```

覆盖：两个 Bot 互相看不到 / 用户会话拿不到 / 人设与 instructions / history 与群分支归属 /
无 ws-index 时 Bot 块仍在 / 两块共存且顺序稳定 / 工具读写 / 关闭开关 / 坏输入不抛。

全套 76 项 + 上游 11 项全绿。

---

# 更新报告 · @local/dsh-bot 0.4.1（2026-10-22）

回应外部审计 [issue #1](https://github.com/qingfengyu153781-star/dsh-bot/issues/1)（等级三深度审计）。
本版只做**修复与新增能力**，不改既有工具签名。

## 一、P1 权限绕过（已修，含审计未发现的第二个入口）

**根因**：`callerBot()` 只按 `bot.sessionId === exec.agent.id` 认人。凡是不等于该 Bot **当前主会话**的会话，
一律被当作「用户」，于是 `main` 闸门失效。`callerBot()` 是单一入口，5 个闸门共用：
`bot_create`、`bot_set_main`、`bot_open`、`group_create`、`group_set_mode`。

**两个入口**（均在临时 `DSH_HOME` 下复现）：

| # | 入口 | 修复前 |
|---|---|---|
| 1 | 群成员分支会话（审计报告的那条） | `bot_set_main` 返回 `changed: -wb1 +n1`，角色 Bot 自封主位 |
| 2 | **`bot_open` 之后的旧会话**（本版新发现） | 同样自封成功；**不需要群**，角色 Bot 只要开过一次新对话就有后门 |

**修复**：`callerBot()` 认三个来源——`bot.sessionId`、`bot.history[]`、`group.branches[botId].sessionId`。
三者都不在的会话仍按「用户」放行（用户自己的会话同样不在 Bot 登记里，默认拒绝会误伤用户）。

## 二、收养去重

`group_create` 带 `sessionId` 时，若该会话已属于别的群则拒绝。此前同一会话可以同时出现在两个群里。

## 三、工作区闸

`workspace` 参数此前接受任意绝对路径（只拦控制字符），记忆/索引可被写到仓库外任意可写目录。
现在只放行**已登记工作区**或**本会话 cwd 及其子目录**；要越界必须显式配置 `allowUnregisteredWorkspace: true`。

## 四、投递失败分类

群成员会话被占（`already owned by an active turn` / `session/writer-held`）此前整轮失败且无重试语义。
现在：投递层按占用类错误退避重投 3 次；仍失败且判定**可重试**的成员，本轮末尾再补投一次；
其他错误判**永久失败**，不重投。返回里明确标出「可重试 / 永久失败 / 已补投 N 位 / 仍被占用」。

## 五、群轮次落盘（96a45860 补回）

每轮结束先 `flushStateWrites()` 再释放群队列，避免下一轮读到 150ms 合并写之前的旧快照（丢 `log`/`rounds`）。

## 六、新增：工作区索引记忆（ws-index）

每轮自动把 `<workspace>/.dsh-bot/WS_INDEX.md` 注入系统提示（`systemPrompt.context`），
从会话 cwd 向上查找归属、8 KB 上限、失败静默降级、与宿主 `AGENTS.md` 注入去重。
新增两个工具：`ws_index_show`（只读回显注入块）、`ws_index_set`（写入/追加）。

## 七、许可证与版本

- 补 MIT `LICENSE`（此前无许可证＝保留所有权利，无法合规分发）；
- `package.json` 版本从 `0.1.0` 对齐到 `0.4.1`（此前元数据陈旧，外部按包元数据判版本会判错）。

## 八、回归测试

```sh
node test/test_ws_index.mjs        # 28 项
node test/test_perm_matrix.mjs     # 14 项（含变异对照：打修复前的文件会红 7 项）
node test/test_ws_scope_retry.mjs  #  9 项（含变异对照：打修复前的文件会红 5 项）
```

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
