# 把本目录的 index.js 同步到已装副本，并校验哈希
# 用法：pwsh -File tools/sync-installed.ps1 [-ProfileDir <profile 路径>]
#
# 为什么需要它：插件运行时读的是 profile 里的副本，源码改动必须显式同步一次；
# 手工两边各改一份时很容易互相覆盖（实测发生过一次：加了新代码的副本被旧副本盖回去）。

param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'index.js'
$target = Join-Path $ProfileDir 'node_modules\@local\dsh-bot\index.js'

if (-not (Test-Path $source)) { throw "source not found: $source" }
if (-not (Test-Path $target)) { throw "installed copy not found: $target (is the bundle installed?)" }

$before = (Get-FileHash $target -Algorithm SHA256).Hash
Copy-Item $source $target -Force
$srcHash = (Get-FileHash $source -Algorithm SHA256).Hash
$dstHash = (Get-FileHash $target -Algorithm SHA256).Hash

"source    : $source"
"installed : $target"
"before    : $($before.Substring(0,16))"
"after     : $($dstHash.Substring(0,16))"
if ($srcHash -ne $dstHash) { throw "hash mismatch after copy" }
"OK: installed copy now equals source (restart DSH to load it)"
