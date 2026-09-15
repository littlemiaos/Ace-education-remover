# PVG harness 本地服务
#
# 扩展的动态注册只作用于 http/https(以及需单独开启的 file 访问),所以用本地
# HTTP 服务打开检测页,顺便让「服务器 Date 头」这一路独立时钟可用。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

Write-Host ""
Write-Host "  PVG harness" -ForegroundColor Cyan
Write-Host "  根目录: $root"
Write-Host "  地址:   http://127.0.0.1:$port/" -ForegroundColor Green
Write-Host "  停止:   Ctrl+C"
Write-Host ""

if (Get-Command py -ErrorAction SilentlyContinue) {
    py -m http.server $port --bind 127.0.0.1 --directory $root
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    python -m http.server $port --bind 127.0.0.1 --directory $root
} else {
    Write-Host "找不到 py / python。装一个 Python,或直接用 npx serve:" -ForegroundColor Yellow
    Write-Host "  npx --yes serve -l $port `"$root`""
    exit 1
}
