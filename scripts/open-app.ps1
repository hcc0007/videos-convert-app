$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = "C:\Applications\nodejs\node-v22.21.0-win-x64\node.exe"
if (-not (Test-Path $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
$url = "http://127.0.0.1:3927/"
$dist = Join-Path $root "dist\index.html"

function Show-Message([string]$text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, "视频转换") | Out-Null
}

if (-not (Test-Path $node)) {
  Show-Message "找不到 Node.js，无法启动视频转换。"
  exit 1
}
if (-not (Test-Path $dist)) {
  Show-Message "应用界面还没有打包。请先在项目目录运行 npm run build:web。"
  exit 1
}

function Test-AppReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content -match "<html"
  } catch {
    return $false
  }
}

function Stop-OldServer {
  $listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3927 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match "server[/\\]index\.mjs") {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not (Test-AppReady)) {
  $busy = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3927 -State Listen -ErrorAction SilentlyContinue
  if ($busy) { Stop-OldServer }
  foreach ($i in 1..20) {
    $still = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3927 -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Process -FilePath $node -ArgumentList "server\index.mjs" -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  $ready = $false
  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 250
    if (Test-AppReady) { $ready = $true; break }
  }
  if (-not $ready) {
    Show-Message "视频转换启动超时。请查看项目目录后重试。"
    exit 1
  }
}

$pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
$candidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$pf86\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$pf86\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) {
  $appArg = "--app=$url"
  Start-Process -FilePath $browser -ArgumentList @($appArg, "--window-size=1120,820")
} else {
  Start-Process $url
}
