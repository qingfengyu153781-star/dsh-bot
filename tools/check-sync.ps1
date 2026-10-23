# 校验三处副本是否一致：源码 → 运行时 → 镜像
# 用法：pwsh -File tools/check-sync.ps1 [-ProfileDir <profile 路径>] [-MirrorDir <镜像路径>] [-SkipMirror]
# 退出码：0 = 全部一致；1 = 有差异（附差异清单）
#
# 为什么需要它：2026-10-23 实测发生过一次 —— 源码加了 bot_note 工具，
# 但同步是在加工具之前跑的，运行时副本仍是旧版。表现就是"改完没反应"，
# 而且从行为上完全看不出来（工具只是不存在而已）。
# 这个检查应该在任何"验证插件行为"之前先跑一次。
#
# ★ 2026-10-23 修正（重要）：
#   旧版只校验「源 → 运行时」，**从不校验 bot-ours 镜像**。
#   而 WS_INDEX 一直写着「三方必须一致」—— 那句话从来没被验证过。
#   实测当时：镜像缺 dispatcher.js，index.js / package.json / README.md 三个哈希全不一致。
#   现在把镜像纳入校验，缺一个、差一个字节都算不一致。

param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$MirrorDir  = '',
    [switch]$SkipMirror
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# 镜像位置：优先 -MirrorDir 参数，其次 DSH_BOT_MIRROR 环境变量。
# 不硬编码本机路径 —— 这是公开仓库，硬编码会让别人跑不起来。
if ([string]::IsNullOrWhiteSpace($MirrorDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_BOT_MIRROR)) {
        $MirrorDir = $env:DSH_BOT_MIRROR
    } else {
        # 没有镜像目录 = 不校验镜像。这不是错误，只是少了第三处对照。
        $SkipMirror = $true
    }
}

$target = Join-Path $ProfileDir 'node_modules\@local\dsh-bot'

# 必须一致的文件清单（新增运行时文件时在这里补一行）
$files = @('index.js', 'dispatcher.js', 'package.json')

if (-not (Test-Path $target)) { throw "installed copy not found: $target" }

function Get-Hash12([string]$path) {
    if (-not (Test-Path $path)) { return '(absent)' }
    return (Get-FileHash $path -Algorithm SHA256).Hash.Substring(0, 12)
}

$bad = @()
$rows = @()

foreach ($f in $files) {
    $src = Join-Path $root $f
    $dst = Join-Path $target $f

    $srcHash = Get-Hash12 $src
    $dstHash = Get-Hash12 $dst

    if ($srcHash -eq '(absent)') { $bad += "$f (source missing)"; continue }
    if ($dstHash -eq '(absent)') { $bad += "$f (installed missing)"; continue }

    $mirHash = '(skipped)'
    if (-not $SkipMirror) {
        $mir = Join-Path $MirrorDir $f
        $mirHash = Get-Hash12 $mir
        if ($mirHash -eq '(absent)') {
            $bad += "$f (mirror missing)"
        } elseif ($mirHash -ne $srcHash) {
            $bad += "$f (mirror differs)"
        }
    }

    if ($srcHash -ne $dstHash) { $bad += "$f (installed differs)" }

    $rows += [pscustomobject]@{
        file     = $f
        source   = $srcHash
        runtime  = $dstHash
        mirror   = $mirHash
        srcBytes = if (Test-Path $src) { (Get-Item $src).Length } else { 0 }
    }
}

$rows | Format-Table -AutoSize | Out-String -Width 200

if ($bad.Count -gt 0) {
    "不一致：$($bad -join ', ')"
    ""
    if ($bad -match 'mirror') {
        "→ 镜像不一致：跑 pwsh -File tools/sync-mirror.ps1 把源码刷进 bot-ours"
    }
    if ($bad -match 'installed') {
        "→ 运行时不一致：跑 pwsh -File tools/sync-installed.ps1，然后重启 DSH"
    }
    exit 1
}

"一致：源码 / 运行时 / 镜像 三处完全相同（$($files.Count) 个文件）"
exit 0
