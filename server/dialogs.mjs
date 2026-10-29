import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: false },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `无法打开系统选择窗口（${code}）`));
    });
  });
}

async function withPickerScript(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "convert-videos-"));
  const resultPath = path.join(dir, "result.txt");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles() | Out-Null
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = "CenterScreen"
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
${body}
$owner.Dispose()
[System.IO.File]::WriteAllLines(${psQuote(resultPath)}, [string[]]$lines.ToArray(), [System.Text.UTF8Encoding]::new($false))
`;
  try {
    await runScript(script);
    const text = await readFile(resultPath, "utf8").catch(() => "");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function pickVideoFiles() {
  return withPickerScript(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Title = "选择视频文件"
$dialog.Filter = "视频文件|*.mp4;*.m4v;*.avi;*.mkv;*.mov;*.webm;*.flv;*.wmv;*.mpg;*.mpeg;*.3gp|所有文件|*.*"
$ok = $dialog.ShowDialog($owner)
$lines = New-Object System.Collections.Generic.List[string]
if ($ok -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($name in $dialog.FileNames) { [void]$lines.Add($name) }
}
`);
}

export async function pickOutputFolder() {
  const lines = await withPickerScript(`
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择转换后视频的保存文件夹"
$dialog.ShowNewFolderButton = $true
$ok = $dialog.ShowDialog($owner)
$lines = New-Object System.Collections.Generic.List[string]
if ($ok -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [void]$lines.Add($dialog.SelectedPath)
}
`);
  return lines[0] ?? "";
}
