import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const FORMAT_OUTPUT = {
  mp4: ".mp4",
  avi: ".avi",
  mkv: ".mkv",
  mov: ".mov",
  webm: ".webm",
  flv: ".flv",
  wmv: ".wmv",
  mpeg: ".mpg",
};

const FORMAT_EXTENSIONS = {
  mp4: [".mp4", ".m4v"],
  avi: [".avi"],
  mkv: [".mkv"],
  mov: [".mov"],
  webm: [".webm"],
  flv: [".flv"],
  wmv: [".wmv"],
  mpeg: [".mpg", ".mpeg"],
};

export function outputExtension(formatId) {
  return FORMAT_OUTPUT[formatId];
}

export function matchesSource(filePath, formatId) {
  const ext = path.extname(filePath).toLowerCase();
  return (FORMAT_EXTENSIONS[formatId] ?? []).includes(ext);
}

export function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, "C:\\Applications\\FFmpeg\\bin\\ffmpeg.exe"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // try the next location
    }
  }
  const located = spawnSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true });
  if (located.status === 0) {
    const line = located.stdout.split(/\r?\n/).find((item) => item.trim());
    if (line) return line.trim();
  }
  return null;
}

function codecArgs(target) {
  switch (target) {
    case "mp4":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    case "avi":
      return ["-c:v", "libxvid", "-q:v", "4", "-c:a", "libmp3lame", "-q:a", "3"];
    case "mkv":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k"];
    case "mov":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"];
    case "webm":
      return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"];
    case "flv":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k"];
    case "wmv":
      return ["-c:v", "wmv2", "-b:v", "2M", "-c:a", "wmav2", "-b:a", "128k"];
    case "mpeg":
      return ["-c:v", "mpeg2video", "-b:v", "4M", "-c:a", "mp2", "-b:a", "192k"];
    default:
      throw new Error(`不支持的目标格式：${target}`);
  }
}

function parseClock(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function probeDuration(ffmpeg, input, control) {
  return new Promise((resolve) => {
    if (control.stopped()) {
      resolve(0);
      return;
    }
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", input], { windowsHide: true });
    control.attach(child);
    let stderr = "";
    let duration = 0;
    child.stderr.on("data", (chunk) => {
      if (duration) return;
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (match) duration = parseClock(`${match[1]}:${match[2]}:${match[3]}`) ?? 0;
    });
    child.on("close", () => resolve(control.stopped() ? 0 : duration));
    child.on("error", () => resolve(0));
  });
}

function isNonEmptyFile(filePath) {
  try {
    const info = statSync(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function allocateOutputs(outputDir, inputs, extension) {
  const reserved = new Set();
  return inputs.map((input) => {
    const base = path.basename(input, path.extname(input));
    const inputKey = path.resolve(input).toLowerCase();
    for (let index = 0; index < 10000; index += 1) {
      const suffix = index === 0 ? "" : ` (${index})`;
      const output = path.join(outputDir, `${base}${suffix}${extension}`);
      const key = path.resolve(output).toLowerCase();
      if (key === inputKey || reserved.has(key)) continue;
      reserved.add(key);
      return { input, output, skipped: isNonEmptyFile(output) };
    }
    throw new Error(`无法为 ${base} 分配输出文件名`);
  });
}

function stoppedError() {
  const error = new Error("已停止");
  error.stopped = true;
  return error;
}

export function convertFile(ffmpeg, input, output, target, onProgress, control = {}) {
  return new Promise((resolve, reject) => {
    let current = null;
    let stopRequested = false;
    const stop = () => {
      stopRequested = true;
      if (current && !current.killed) current.kill();
    };
    control.bind?.({ stop, pid: () => current?.pid ?? null });

    probeDuration(ffmpeg, input, {
      attach(child) {
        current = child;
      },
      stopped: () => stopRequested,
    })
      .then((duration) => {
        if (stopRequested) {
          reject(stoppedError());
          return;
        }
        let settled = false;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          handler(value);
        };
        const child = spawn(
          ffmpeg,
          [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            ...codecArgs(target),
            "-progress",
            "pipe:1",
            "-nostats",
            output,
          ],
          { windowsHide: true },
        );
        current = child;
        control.onEncoder?.(child);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });
        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          if (line.startsWith("out_time=")) {
            const clock = parseClock(line.slice("out_time=".length));
            if (clock != null && duration > 0) {
              onProgress(Math.max(0, Math.min(99, (clock / duration) * 100)));
            }
          }
          if (line === "progress=end") onProgress(100);
        });
        child.on("error", (error) => {
          lines.close();
          finish(reject, error);
        });
        child.on("close", (code) => {
          lines.close();
          if (stopRequested) {
            finish(reject, stoppedError());
            return;
          }
          if (code === 0) {
            onProgress(100);
            finish(resolve);
            return;
          }
          const detail = stderr.trim().split(/\r?\n/).slice(-6).join(" ");
          finish(reject, new Error(detail || `ffmpeg 退出码 ${code}`));
        });
      })
      .catch(reject);
  });
}
