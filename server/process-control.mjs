import { spawn } from "node:child_process";
import readline from "node:readline";

const workerScript = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeProcCtl {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")]
  public static extern int NtResumeProcess(IntPtr handle);
}
'@
Write-Output "READY"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -eq 'exit') { break }
  $bits = $line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
  if ($bits.Length -lt 2) { Write-Output 'ERR 无效指令'; continue }
  try {
    $procId = [int]$bits[1]
    $handle = [NativeProcCtl]::OpenProcess(2035711, $false, $procId)
    if ($handle -eq [IntPtr]::Zero) { throw "无法打开进程 $procId（$([Runtime.InteropServices.Marshal]::GetLastWin32Error())）" }
    try {
      $code = if ($bits[0] -eq 'suspend') { [NativeProcCtl]::NtSuspendProcess($handle) } else { [NativeProcCtl]::NtResumeProcess($handle) }
      if ($code -ne 0) { throw "状态码 $code" }
    } finally {
      [void][NativeProcCtl]::CloseHandle($handle)
    }
    Write-Output "OK $procId"
  } catch {
    Write-Output ("ERR " + $_.Exception.Message)
  }
}
`;

let worker = null;
let queue = Promise.resolve();

function shutdownWorker() {
  if (!worker) return;
  const current = worker;
  worker = null;
  current.pending?.reject(new Error("进程控制已关闭"));
  current.child.kill();
}

function startWorker() {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(workerScript, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.unref();
  child.stdin.unref();
  child.stdout.unref();
  child.stderr.unref();
  const session = { child, pending: null, ready: null };
  session.ready = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line === "READY") {
      session.resolveReady?.();
      return;
    }
    if (!line.startsWith("OK ") && !line.startsWith("ERR ")) return;
    const pending = session.pending;
    session.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (line.startsWith("OK ")) pending.resolve();
    else pending.reject(new Error(line.slice(4).trim() || "无法控制转换进程"));
  });
  child.on("exit", () => {
    session.rejectReady?.(new Error("进程控制意外退出"));
    session.pending?.reject(new Error("进程控制意外退出"));
    session.pending = null;
    if (worker === session) worker = null;
  });
  worker = session;
  return session;
}

function ensureWorker() {
  if (worker && !worker.child.killed) return worker.ready.then(() => worker);
  return startWorker().ready.then(() => worker);
}

function send(action, pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return Promise.reject(new Error("无效的进程号"));
  }
  const run = () =>
    ensureWorker().then(
      (session) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (session.pending?.pid === numeric) {
              session.pending = null;
              reject(new Error("控制转换进程超时"));
            }
          }, 15000);
          session.pending = { pid: numeric, resolve, reject, timer };
          session.child.stdin.write(`${action} ${numeric}\n`);
        }),
    );
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function suspendProcess(pid) {
  return send("suspend", pid);
}

export function resumeProcess(pid) {
  return send("resume", pid);
}

export function warmProcessControl() {
  return ensureWorker().then(() => undefined);
}

process.on("exit", shutdownWorker);
