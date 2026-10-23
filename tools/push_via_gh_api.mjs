#!/usr/bin/env node
/**
 * push_via_gh_api.mjs —— 用 GitHub API 推送（本机 github.com 不通，api.github.com 通）
 *
 * 背景：
 *   git push 走 https://github.com/... → 本机超时（Connection reset）
 *   gh api 走 https://api.github.com/ → 200 可用
 *   所以用 Git Data API 手工构造 commit 并更新 ref。
 *
 * ⚠ 本地与远程已分叉（2026-10-23 发现）：
 *   远程 96a4586 之后多了 0.4.1 / 0.4.2 两个提交，本地直接跳到 0.5.0。
 *   但本地内容已包含远程全部功能（逐行比对：2140 非空行只差 4 行，其中 3 行是有意脱敏）。
 *   策略：以本地内容为准，parent 挂远程 master（fast-forward，不 force）。
 *
 * 用法：
 *   node tools/push_via_gh_api.mjs --repo <owner/name> --dry-run
 *   node tools/push_via_gh_api.mjs --repo <owner/name>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 仓库根 = 本脚本所在目录的上一级（不硬编码本机路径）
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const has = (k) => args.includes(k)

const REPO = get('--repo')
if (!REPO) { console.error('用法：--repo <owner/name> [--dry-run]'); process.exit(1) }
const DRY = has('--dry-run')

// 要删除的远程路径（用户要求：仓库不含测试文件）
const DELETE_PATHS = [
  'test/group_queue.test.mjs',
  'test/test_bot_memory.mjs',
  'test/test_perm_matrix.mjs',
  'test/test_surface.mjs',
  'test/test_ws_index.mjs',
  'test/test_ws_scope_retry.mjs',
]

function gh(argv, input) {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  if (input !== undefined) opts.input = typeof input === 'string' ? input : JSON.stringify(input)
  const out = execFileSync('gh', argv, opts)
  return out.trim() ? JSON.parse(out) : null
}
function git(argv) {
  return execFileSync('git', argv, { cwd: REPO_DIR, encoding: 'utf8' }).trim()
}

console.log('='.repeat(70))
console.log(`推送 ${REPO}（via GitHub API）${DRY ? ' · DRY RUN' : ''}`)
console.log('='.repeat(70))

const ref = gh(['api', `repos/${REPO}/git/ref/heads/master`])
const baseSha = ref.object.sha
const baseCommit = gh(['api', `repos/${REPO}/git/commits/${baseSha}`])
const baseTree = baseCommit.tree.sha
console.log(`\n远程 master: ${baseSha.slice(0, 7)} — ${String(baseCommit.message).split('\n')[0].slice(0, 60)}`)
console.log(`远程 tree  : ${baseTree.slice(0, 7)}`)

const tracked = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)
console.log(`\n本地跟踪文件 ${tracked.length} 个`)

const treeItems = []
let pushed = 0
for (const p of tracked) {
  const abs = join(REPO_DIR, p)
  if (!existsSync(abs)) { console.log(`  ⚠ 跳过（不存在）：${p}`); continue }
  const buf = readFileSync(abs)
  if (DRY) { treeItems.push({ path: p, mode: '100644', type: 'blob', sha: 'DRY' }); pushed++; continue }
  const blob = gh(['api', `repos/${REPO}/git/blobs`, '--method', 'POST', '--input', '-'],
    { content: buf.toString('base64'), encoding: 'base64' })
  treeItems.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha })
  pushed++
  console.log(`  blob ${blob.sha.slice(0, 7)}  ${p} (${buf.length} B)`)
}

const remoteTree = gh(['api', `repos/${REPO}/git/trees/${baseTree}?recursive=1`])
const remotePaths = remoteTree.tree.filter((x) => x.type === 'blob').map((x) => x.path)
const remoteSet = new Set(remotePaths)
const dels = DELETE_PATHS.filter((p) => remoteSet.has(p))
console.log(`\n删除远程测试文件 ${dels.length} 个：`)
for (const p of dels) {
  treeItems.push({ path: p, mode: '100644', type: 'blob', sha: null })
  console.log(`  del  ${p}`)
}

if (DRY) {
  console.log(`\n[dry] 将写 ${pushed} 个文件 + 删 ${dels.length} 个`)
  console.log('[dry] 实际未执行')
  process.exit(0)
}
const tree = gh(['api', `repos/${REPO}/git/trees`, '--method', 'POST', '--input', '-'],
  { base_tree: baseTree, tree: treeItems })
console.log(`\ntree: ${tree.sha.slice(0, 7)}`)

const msg = git(['log', '-1', '--format=%B', 'HEAD'])
const commit = gh(['api', `repos/${REPO}/git/commits`, '--method', 'POST', '--input', '-'],
  { message: msg, tree: tree.sha, parents: [baseSha] })
console.log(`commit: ${commit.sha.slice(0, 7)}`)

const updated = gh(['api', `repos/${REPO}/git/refs/heads/master`, '--method', 'PATCH', '--input', '-'],
  { sha: commit.sha, force: false })
console.log(`\n✓ 已推送：${REPO} master → ${commit.sha.slice(0, 7)}`)
console.log(`  ref 确认：${updated.object.sha === commit.sha ? '一致' : '⚠ 不一致'}`)
