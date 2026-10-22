// ws-index（工作区索引记忆）回归测试。
// 用临时工作区 + 临时 DSH_HOME，不依赖本机路径。
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN = process.env.DSBOT_INDEX || fileURLToPath(new URL('../index.js', import.meta.url))
const HOME = join(tmpdir(), `dsbot-wsindex-home-${Date.now()}`)
process.env.DSH_HOME = HOME

const WS = join(tmpdir(), `dsbot-wsindex-ws-${Date.now()}`)
const INDEX_REL = join('.dsh-bot', 'WS_INDEX.md')

let pass = 0
const fails = []
function check(name, cond, detail = '') {
  cond ? pass++ : fails.push(name)
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` :: ${detail}` : ''}`)
}

function makeCtx() {
  const tools = new Map()
  const contexts = []
  const ctx = {
    tools: { register: def => (tools.set(def.name, def), () => tools.delete(def.name)) },
    get: () => undefined,
    effect: fn => {
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    inject: (deps, cb) => {
      cb({
        systemPrompt: {
          section: () => () => {},
          context: spec => {
            contexts.push(spec)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, tools, contexts }
}

const assemblyFor = cwd => ({ agent: { session: { header: { cwd } } } })
const asSession = cwd => ({ agent: { id: 'test', session: { header: { cwd } } } })

async function load(config = {}) {
  const mod = await import(`${pathToFileURL(PLUGIN).href}?v=${Math.random()}`)
  const { ctx, tools, contexts } = makeCtx()
  mod.apply(ctx, config)
  return { mod, tools, contexts }
}

await mkdir(join(WS, '.dsh-bot'), { recursive: true })
await mkdir(join(HOME, 'bot-ours'), { recursive: true })
await writeFile(join(WS, INDEX_REL), '# 测试工作区索引\n\n## 入口\n\n- 索引页：`docs/README.md`\n- 快照：445 份\n', 'utf8')

console.log('\n[1] 注入块')
{
  const { tools, contexts } = await load()
  check('注册了且只注册了一条 context', contexts.length === 1, `contexts=${contexts.length}`)
  check('context 名字是 ws-index:workspace', contexts[0]?.name === 'ws-index:workspace')
  const text = contexts[0].text(assemblyFor(WS))
  check('带开始标记', text.includes('<!-- ws-index:v1 -->'))
  check('带结束标记', text.includes('<!-- /ws-index:v1 -->'))
  check('指向 WS_INDEX.md', text.includes(join(WS, INDEX_REL)))
  check('带工作区行', text.includes(`工作区：${WS}`))
  check('带索引正文', text.includes('测试工作区索引') && text.includes('445'))
  check('未超上限（无截断提示）', !text.includes('已截断'), `len=${Buffer.byteLength(text)}B`)
  check('工具 ws_index_show 已注册', tools.has('ws_index_show'))
  check('工具 ws_index_set 已注册', tools.has('ws_index_set'))
}

console.log('\n[2] 子目录会话归属同一工作区')
{
  const { contexts } = await load()
  const sub = join(WS, 'a', 'b')
  const text = contexts[0].text(assemblyFor(sub))
  check('子目录也注入（向上找到同一份）', text.includes(join(WS, INDEX_REL)))
  check('子目录时仍写实际 cwd', text.includes(sub))
}

console.log('\n[3] 无索引的目录：静默空串')
{
  const { contexts } = await load()
  check('返回空串', contexts[0].text(assemblyFor(join(tmpdir(), 'dsbot-nothing-here'))) === '')
}

console.log('\n[4] 拿不到 cwd / 畸形 assemblyCtx：不抛')
{
  const { contexts } = await load()
  let threw = null
  let out = 'x'
  try {
    out = contexts[0].text(undefined)
  } catch (e) {
    threw = e
  }
  check('undefined 不抛且返回空串', threw === null && out === '')
  try {
    check('空 agent 返回空串', contexts[0].text({ agent: {} }) === '')
  } catch (e) {
    check('空 agent 返回空串', false, String(e))
  }
}

console.log('\n[5] 超限截断（20 KB 正文）')
{
  const big = join(tmpdir(), `dsbot-big-${Date.now()}`)
  await mkdir(join(big, '.dsh-bot'), { recursive: true })
  await writeFile(join(big, INDEX_REL), `# 大文件\n\n${'甲'.repeat(7000)}\n`, 'utf8')
  const { contexts } = await load()
  const text = contexts[0].text(assemblyFor(big))
  check('带截断提示', text.includes('已截断'))
  check('多字节字符没被截成半个（无替换符）', !text.includes('\uFFFD'))
  check('总长受控', Buffer.byteLength(text, 'utf8') < 8192 + 900, `len=${Buffer.byteLength(text, 'utf8')}`)
  await rm(big, { recursive: true, force: true })
}

console.log('\n[6] 索引文件被删：空串 + 不抛')
{
  const empty = join(tmpdir(), `dsbot-empty-${Date.now()}`)
  await mkdir(join(empty, '.dsh-bot'), { recursive: true })
  const { contexts } = await load()
  check('没有文件时返回空串', contexts[0].text(assemblyFor(empty)) === '')
  await rm(empty, { recursive: true, force: true })
}

console.log('\n[7] ws_index_set：写入 / 追加 / 缓存失效')
{
  const tmp = join(tmpdir(), `dsbot-write-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  const { tools, contexts } = await load()
  const set = tools.get('ws_index_set')
  const r1 = await set.execute({ workspace: tmp, content: '# 一\n\n- a' }, asSession(tmp))
  check('replace 写入成功', String(r1.text).includes('已写入'), String(r1.text))
  check('注入里能读到刚写的内容', contexts[0].text(assemblyFor(tmp)).includes('- a'))
  const r2 = await set.execute({ workspace: tmp, content: '- b', mode: 'append' }, asSession(tmp))
  check('append 成功', String(r2.text).includes('已追加'))
  const body = await readFile(join(tmp, INDEX_REL), 'utf8')
  check('追加后两条都在', body.includes('- a') && body.includes('- b'), body)
  check('缓存已失效（新一轮立刻见到 b）', contexts[0].text(assemblyFor(tmp)).includes('- b'))
  const r3 = await tools.get('ws_index_show').execute({ workspace: tmp }, asSession(tmp))
  check('ws_index_show 回显注入块', String(r3.text).includes('<!-- ws-index:v1 -->'))
  await rm(tmp, { recursive: true, force: true })
}

console.log('\n[8] 与宿主 agent-instructions 去重：索引名叫 AGENTS.md 时不注入')
{
  const { contexts } = await load({ indexFile: 'AGENTS.md' })
  check('不注册 context（避免双份）', contexts.length === 0, `contexts=${contexts.length}`)
}

console.log('\n[9] 配置：关掉就不注入；自定义文件名生效')
{
  check('indexEnabled=false 不注册', (await load({ indexEnabled: false })).contexts.length === 0)
  check('自定义文件名已生效', (await load({ indexFile: '.dsh-bot/CUSTOM.md' })).contexts.length === 1)
}

await rm(WS, { recursive: true, force: true })
await rm(HOME, { recursive: true, force: true })
console.log(`\n结果：PASS ${pass} / FAIL ${fails.length}`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(' -', f)
  process.exitCode = 1
}
