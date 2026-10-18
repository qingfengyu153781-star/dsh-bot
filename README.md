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
| `memory_remember` / `memory_recall` | ✅ | ✅ | ✅（只限本工作区） |

主位判定不靠名字：Bot 记录上有 `main: true`，一个工作区最多一个；切换时自动撤销旧主位，`changed` 会带 `名字#短id`（同名也能分辨）。

## 工具（12 个）

| 工具 | 作用 |
|---|---|
| `bot_create` | 建角色 Bot（仅主 Bot / 用户） |
| `bot_list` | 按工作区列出所有 Bot；末尾「自检」段报告残缺登记（只标记不删除） |
| `bot_open` | 为某个 Bot 开一条新对话（旧对话进 `history` 保留） |
| `bot_message` | 给某个 Bot 发消息；**分开报告「已入队」与「对方能否响应」** |
| `bot_attach` | 把既有 Bot 会话挂进它的工作区分组（仅主 Bot / 用户） |
| `bot_set_main` | 指定/取消某工作区的主 Bot；同名时按 `id` 精确定位 |
| `group_create` | 建群，或用 `sessionId` 收养既有会话（仅主 Bot / 用户） |
| `group_post` / `group_read` | 往群里发 / 读群消息 |
| `memory_remember` / `memory_recall` | 写 / 读某个工作区的记忆 |
| `session_probe` | 诊断一条会话：inspect / projections / page / resolveAgent / 命令表 |

## 斜杠命令

在任意对话里输入 `/`，会看到：

```
main   ★ 把这个对话登记为 Bot 并设为主 Bot（已是 Bot 时：再执行一次＝取消）
```

- 该会话还不是 Bot ⇒ 就地登记（`id` = 该会话 id，`name` = 会话标题或文件夹名），并设为主 Bot；
- 已是 Bot ⇒ 切换主位；角色 Bot 执行会被拒绝（不能自封）；
- 说明：DSH 的命令名不接受非 ASCII，所以命令名只能是 `main`，中文只出现在描述行。

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

## 许可证

私有使用，未附开源许可证。
