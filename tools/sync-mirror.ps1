# 把源码刷进 bot-ours 镜像，并逐文件校验
# 用法：pwsh -File tools/sync-mirror.ps1 [-MirrorDir <镜像路径>]
#
# 为什么需要它：
#   2026-10-23 实测发现 bot-ours/dsh-bot 是一份 10-22 的旧副本 ——
#   缺 dispatcher.js，index.js / package.json / README.md 三个哈希全不一致。
#   而 check-sync.ps1 从不校验镜像，所以「三方一致」这句话一直是假的。
#   现在补上：check-sync 会报差异，本脚本负责修。
#
# 镜像保留自己独有的文件（install-ws-index.sh、patch_ws_index.py、test_*.mjs），
# 只覆盖插件包文件，不删除任何东西。

param(
    [string]$MirrorDir = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# 镜像位置：优先 -MirrorDir 参数，其次 DSH_BOT_MIRROR 环境变量。
# 不硬编码本机路径 —— 这是公开仓库，硬编码会让别人跑不起来。
if ([string]::IsNullOrWhiteSpace($MirrorDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_BOT_MIRROR)) {
        $MirrorDir = $env:DSH_BOT_MIRROR
    } else {
        throw '未指定镜像目录：请传 -MirrorDir 或设置 DSH_BOT_MIRROR 环境变量'
    }
}

if (-not (Test-Path $MirrorDir)) {
    throw "mirror dir not found: $MirrorDir"
}

# 只覆盖插件包文件；镜像独有的脚本不动
$files = @('index.js', 'dispatcher.js', 'package.json', 'README.md')

$rows = @()
foreach ($f in $files) {
    $src = Join-Path $root $f
    $dst = Join-Path $MirrorDir $f

    if (-not (Test-Path $src)) {
        # README.md 之类可选文件缺失就跳过，不报错
        if ($f -eq 'README.md') { continue }
        throw "source not found: $src"
    }

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

# 镜像独有的文件应当保留，列出来确认没被误删
$extra = Get-ChildItem $MirrorDir -File | Where-Object { $files -notcontains $_.Name } | Select-Object -ExpandProperty Name
if ($extra) {
    "镜像独有文件（已保留）：$($extra -join ', ')"
}

"OK: $($rows.Count) 个文件已刷入镜像 $MirrorDir"
"→ 再跑 pwsh -File tools/check-sync.ps1 确认三方一致"
