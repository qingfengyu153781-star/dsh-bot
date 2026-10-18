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
