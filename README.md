# @local/dsh-bot

给 DeepSeek Harness（DSH）用的**多 Bot 工作区**插件：Bot 就是真实的 DSH 会话，按工作区分组、每个工作区一份独立记忆、群聊可以收养既有会话。

> 本仓库是**本地自研插件**（不是从 npm 安装的第三方包）。装法见「安装」。

## 它解决什么

- 一个工作区里可以有 **主 Bot + 若干角色 Bot**（侦察 / 实施 / 审计 / 反方-审计 …），各自是独立会话，天然出现在侧栏；
- **只有主 Bot 能建 Bot**，角色 Bot 只能开对话、传话；
- **每个工作区一份记忆**（存在 `<workspace>/.dsh-bot/memory/`），项目之间不串味；
- **群聊 = 真实会话**：可以新建，也可以**收养**已有会话（不改名、不移动、不复制）。

## 权限矩阵

| 能力 | 用户会话（你） | 主 Bot | 角色 Bot |
|---|---|---|---|
| `bot_create` 建 Bot | ✅（可建主 Bot） | ✅（只能建子角色） | ❌ 拒绝 |
| `bot_set_main` 切换主位 | ✅ | ✅（仅本工作区） | ❌ 拒绝 |
| `bot_open` 开新对话 | ✅ | ✅ | ✅ |
| `bot_message` 传话 | ✅ | ✅ | ✅ |
| `bot_attach` 整理工作区 | ✅ | ✅ | ❌ 拒绝 |
| `group_create` 建群 | ✅ | ✅ | ❌ 拒绝 |
| `group_post` / `group_read` | ✅ | ✅ | ✅ |
| `workspace_memory_remember` / `workspace_memory_recall` | ✅ | ✅ | ✅（只限本工作区） |

主位判定不靠名字：Bot 记录上有 `main: true`，一个工作区最多一个；切换时自动撤销旧主位，`changed` 会带 `名字#短id`（同名也能分辨）。

## 工具（17 个）

| 工具 | 作用 |
|---|---|
| `bot_create` | 建角色 Bot（仅主 Bot / 用户） |
| `bot_list` | 按工作区列出所有 Bot；末尾「自检」段报告残缺登记（只标记不删除） |
| `bot_open` | 为某个 Bot 开一条新对话（旧对话进 `history` 保留） |
| `bot_message` | 给某个 Bot 发消息；**分开报告「已入队」与「对方能否响应」** |
| `bot_attach` | 把既有 Bot 会话挂进它的工作区分组（仅主 Bot / 用户） |
| `bot_set_main` | 指定/取消某工作区的主 Bot；同名时按 `id` 精确定位 |
| `group_create` | 建群（可选 `mode`），或用 `sessionId` 收养既有会话 |
| `group_post` | 往群里发；`round-robin` 模式下成员按顺序依次发言 |
| `group_read` | 读群的共享记录（成员看到的是同一条有序对话） |
| `group_set_mode` | 切换 `broadcast` / `round-robin`（仅主 Bot / 用户） |
| `workspace_memory_remember` / `workspace_memory_recall` | 写 / 读某个工作区的记忆 |
| `session_probe` | 诊断一条会话：inspect / projections / page / resolveAgent / 命令表 |
| `ws_index_show` | 只读回显「注入到系统提示里的工作区索引块」，以及命中的文件/大小/mtime |
| `ws_index_set` | 写（`replace`）或追加（`append`）工作区索引文件；写完立刻生效 |
| `bot_memory_show` | 只读回显**某个 Bot** 的专属记忆块（身份 + 指令 + 正文） |
| `bot_memory_set` | 写某个 Bot 的专属记忆文件；只有它自己的会话能看到 |

## 工作区索引记忆（ws-index，0.4.1 新增）

给一个工作区放一份索引文件，该工作区**每个会话的每一轮**都自动带上它；内容改了下一轮就跟着变。

| 项 | 值 |
|---|---|
| 索引文件默认路径 | `<workspace>/.dsh-bot/WS_INDEX.md` |
| 注入方式 | `systemPrompt.context`（每轮装配时取值，**不是** `section`——后者注册时就固定了） |
| 归属规则 | 从会话 cwd **向上查找**最近的索引文件（最多 12 层）；子目录会话因此归到所在工作区 |
| 注入上限 | 默认 8192 B，超了按 UTF-8 边界截断并明示；可配（512–65536） |
| 去重 | 索引文件**不许叫** `AGENTS.md` / `CLAUDE.md`：这两个名字归宿主 `agent-instructions` 管，插件再注入一遍就是重复 |
| 失败行为 | 文件缺失 / 读失败 / 渲染异常 → **返回空串 + 记一行日志**，绝不抛（这条路径每轮都跑，抛一次毁掉整个工作区） |

配置：

```yaml
- insert:
    - id: bot-ours
      name: '@local/dsh-bot'
      config:
        indexEnabled: true                 # false = 关掉注入
        indexFile: .dsh-bot/WS_INDEX.md    # 相对 workspace，或绝对路径
        indexMaxBytes: 8192
        indexOrder: 7000                   # 系统提示里的排序
        allowUnregisteredWorkspace: false  # 见「安全边界」
```

## Bot 专属记忆（bot-memory，0.4.2 新增）

**不同的 Bot 拿到不同的记忆**，而不是全工作区共用一份。

| 层 | 文件 | 谁看得到 |
|---|---|---|
| 工作区索引（ws-index） | `<workspace>/.dsh-bot/WS_INDEX.md` | 该工作区**所有会话**（含用户会话） |
| **Bot 专属记忆（bot-memory）** | `<workspace>/.dsh-bot/bots/<bot名>.md` | **只有这个 Bot 自己的会话** |

两者可同时注入：Bot 会话里是「工作区块 + 自己那块」，用户会话里只有工作区块。

**归属判定**与 `callerBot()` 同口径（主会话 / `bot_open` 旧会话 / 群分支会话），
所以同一个 Bot 换过几次会话，记忆都跟着它走。

注入内容（`<!-- bot-memory:v1 -->` 标记块）：

- 身份行：`名字（角色）· 主 Bot`
- 工作区与该 Bot 的记忆文件路径、体积
- **常驻指令**：`bot.instructions`（此前只在登记里躺着，从没进过提示词）
- 记忆正文（默认上限 4096 B，超了按 UTF-8 边界截断）

配置：

```yaml
config:
  botMemoryEnabled: true               # false = 不注入 Bot 专属块
  botMemoryDir: .dsh-bot/bots          # 相对 workspace
  botMemoryMaxBytes: 4096
```

配套工具：`bot_memory_show`（只读回显某个 Bot 的注入块）、`bot_memory_set`（写入/追加）。

## 群聊的两种模式

| 模式 | 行为 |
|---|---|
| `broadcast`（默认） | 消息投给群会话，只有群会话自己的 agent 回 |
| `round-robin` | 成员按顺序依次发言：后一位能看到「本轮之前的上下文」与「本轮到目前为止」，并知道自己处在第几位；无话可说回 `[PASS]` |

每条发言都会以一条独立消息写进群会话（`session.append('user/message', …, { surfaceOp:'append' })`），所以打开群对话就能看到逐条记录，且**不会因此多调一次模型**。

## 斜杠命令

在任意对话里输入 `/`，会看到：

```
main         ★ 把这个对话登记为 Bot 并设为主 Bot（已是 Bot 时：再执行一次＝取消）
groupmode    ★ 切换本群发言模式：轮流发言（成员互相看见）/ 广播
```

- `main`：该会话还不是 Bot ⇒ 就地登记（`id` = 该会话 id，`name` = 会话标题或目录名），并设为主 Bot；已是 Bot ⇒ 切换主位；角色 Bot 执行会被拒绝；
- `groupmode`：只在群会话里有效，执行一次切换一次；
- 说明：宿主不接受非 ASCII 命令名，所以命令名只能是 `main` / `groupmode`，中文只出现在描述行。

## 安装

插件是 bundle 形态，注册进 profile 后重启 DSH 生效：

```jsonc
// <profile>/package.json
{
  "dependencies": { "@local/dsh-bot": "file:D:/agent/dsh-bot" },
  "dsh": { "profile": { "bundles": [/* …原有…, */ "@local/dsh-bot"] } }
}
```

改完 profile 必须**完全退出 DSH** 再启动（运行中改会触发插件树重建，已开会话的工具会失效）。

## 数据

- `~/.dsh/bot-ours/state.json` —— Bot 与群聊登记（派生缓存；**会话日志才是真相源**）
- `<workspace>/.dsh-bot/memory/` —— 该工作区专属记忆（`MEMORY.md` + `topics/*.md`）

`state.json` 读取时会做归一：同区只保留一个主位、缺 `workspaceId` 的登记自动回填、残缺条目只标记不删除；诊断信息（`repairs`）不会写回文件。

## 设计与取舍

- **Bot 即会话**：不另造实体，侧栏、搜索、导出直接复用 DSH 能力；
- **防绕过**：角色 Bot 不能自封主位、不能建群、不能重排工作区；路径含控制字符（单反斜杠写错）在入口就被拦下并给出正确写法；
- **不删任何东西**：整理只移动/登记，不做删除；
- 已知边界：命令名只能是 ASCII；WSL/Linux 未验证（按 Windows 路径语义编写）。

## 测评

插件做过三轮自测（基础 / 回归 / 加固后回归），报告保存在本地、不随仓库发布。
累计 7 条缺陷（P1×2 / P2×4 / P3×1）均已修复并复测；仍未验的是 WSL（本机未安装）与 UI 点击类项目。

## 安装脚本说明

本仓库**只含插件本体**。安装到 profile 的辅助脚本（含本机绝对路径）不随仓库发布。

## 安全边界（0.4.1，回应外部审计 issue #1）

| 项 | 口径 |
|---|---|
| **身份识别**（P1） | `callerBot()` 认三个来源：`bot.sessionId`（当前主会话）、`bot.history[]`（`bot_open` 之后的旧会话）、`group.branches[botId].sessionId`（群分支会话）。三个都不是的会话按「用户」放行——因为用户自己的会话也不在 Bot 登记里，默认拒绝会误伤用户。 |
| **工作区闸** | `bot_create` / `group_create` / `workspace_memory_remember` / `ws_index_set` / `bot_memory_set` 只接受**已登记工作区**或**本会话 cwd 及其子目录**；其余拒绝并提示两条出路。要越界必须显式 `allowUnregisteredWorkspace: true`。 |
| **收养去重** | `group_create` 带 `sessionId` 时，若该会话已属于别的群则拒绝——一个会话只能属于一个群。 |
| **投递失败分类** | 群成员会话被占（`already owned` / `writer-held`）判**可重试**：投递层退避重投 3 次，本轮末尾再补投一次；其他错误判**永久失败**，不重投。 |
| **群轮次落盘** | 每轮结束先 `flushStateWrites()` 再释放群队列，避免下一轮读到 150ms 合并写之前的旧快照（丢 `log`/`rounds`）。 |

回归测试（仓库内，可直接跑）：

```sh
node test/group_queue.test.mjs
node test/test_ws_index.mjs        # 28 项
node test/test_bot_memory.mjs      # 25 项（Bot 专属记忆：隔离 / 归属 / 工具）
node test/test_perm_matrix.mjs     # 14 项
node test/test_ws_scope_retry.mjs  #  9 项
```

## 许可证

MIT（见 `LICENSE`）。公开仓库只放插件本体与文档，不含本机路径、会话记录或项目数据。
