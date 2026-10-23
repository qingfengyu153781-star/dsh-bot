# 把本目录的源码同步到已装副本，并逐文件校验哈希
# 用法：pwsh -File tools/sync-installed.ps1 [-ProfileDir <profile 路径>]
#
# 为什么需要它：插件运行时读的是 profile 里的副本，源码改动必须显式同步一次；
# 手工两边各改一份时很容易互相覆盖（实测发生过一次：加了新代码的副本被旧副本盖回去）。
#
# 2026-10-23 修正：之前只同步 index.js。加了 dispatcher.js 之后，
# 只同步主文件会让 node_modules 里缺依赖，插件会整行加载失败（import 解析不到）。
# 现在按清单逐文件同步 + 逐文件校验，缺任何一个都直接报错。

param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$target = Join-Path $ProfileDir 'node_modules\@local\dsh-bot'

# 必须同步的文件清单（新增运行时文件时在这里补一行）
$files = @('index.js', 'dispatcher.js', 'package.json')

if (-not (Test-Path $target)) { throw "installed copy not found: $target (is the bundle installed?)" }

$rows = @()
foreach ($f in $files) {
    $src = Join-Path $root $f
    $dst = Join-Path $target $f
    if (-not (Test-Path $src)) { throw "source not found: $src" }

    $before = if (Test-Path $dst) { (Get-FileHash $dst -Algorithm SHA256).Hash.Substring(0, 12) } else { '(absent)' }
    Copy-Item $src $dst -Force
    $srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash $dst -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw "hash mismatch after copy: $f" }

    $rows += [pscustomobject]@{
        file   = $f
        before = $before
        after  = $dstHash.Substring(0, 12)
        bytes  = (Get-Item $dst).Length
    }
}

$rows | Format-Table -AutoSize | Out-String -Width 200

# 语法复检：装进去的东西必须能被解析
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -ne $node) {
    foreach ($f in @('index.js', 'dispatcher.js')) {
        $dst = Join-Path $target $f
        & node --check $dst
        if ($LASTEXITCODE -ne 0) { throw "node --check failed: $dst" }
    }
    "node --check: OK (index.js, dispatcher.js)"
}

"OK: $($files.Count) 个文件已同步到 $target（重启 DSH 后加载）"
