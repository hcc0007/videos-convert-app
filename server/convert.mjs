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

const hardwareCache = new Map();
let hardwareProbe = null;

function encoderWorks(ffmpeg, hardware) {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=30:d=0.1",
        "-frames:v",
        "1",
        ...h264Args(hardware),
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 8000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function detectHardware(ffmpeg) {
  if (hardwareCache.has(ffmpeg)) return Promise.resolve(hardwareCache.get(ffmpeg));
  if (!hardwareProbe) {
    hardwareProbe = (async () => {
      const listed = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true });
      const text = `${listed.stdout || ""}\n${listed.stderr || ""}`;
      const candidates = ["nvenc", "qsv", "amf"].filter((name) => new RegExp(`\\bh264_${name}\\b`).test(text));
      let encoder = null;
      for (const name of candidates) {
        if (await encoderWorks(ffmpeg, name)) {
          encoder = name;
          break;
        }
      }
      hardwareCache.set(ffmpeg, encoder);
      return encoder;
    })().finally(() => {
      hardwareProbe = null;
    });
  }
  return hardwareProbe;
}

export function disableHardware(ffmpeg) {
  hardwareCache.set(ffmpeg, null);
}

function h264Args(hardware) {
  if (hardware === "nvenc") {
    return ["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"];
  }
  if (hardware === "qsv") {
    return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"];
  }
  if (hardware === "amf") {
    return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"];
  }
  return ["-c:v", "libx264", "-preset", "superfast", "-crf", "21", "-pix_fmt", "yuv420p", "-threads", "0"];
}

function codecArgs(target, hardware) {
  const h264 = h264Args(["mp4", "mkv", "mov", "flv"].includes(target) ? hardware : null);
  switch (target) {
    case "mp4":
      return [...h264, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    case "mkv":
      return [...h264, "-c:a", "aac", "-b:a", "192k"];
    case "mov":
      return [...h264, "-c:a", "aac", "-b:a", "192k"];
    case "flv":
      return [...h264, "-c:a", "aac", "-b:a", "128k"];
    case "avi":
      return ["-c:v", "mpeg4", "-q:v", "5", "-threads", "0", "-c:a", "libmp3lame", "-q:a", "3"];
    case "webm":
      return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-threads", "8", "-tile-columns", "2", "-c:a", "libopus", "-b:a", "128k"];
    case "wmv":
      return ["-c:v", "wmv2", "-b:v", "2M", "-threads", "0", "-c:a", "wmav2", "-b:a", "128k"];
    case "mpeg":
      return ["-c:v", "mpeg2video", "-b:v", "4M", "-threads", "0", "-c:a", "mp2", "-b:a", "192k"];
    default:
      throw new Error(`不支持的目标格式：${target}`);
  }
}

function parseClock(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function findFfprobe(ffmpeg) {
  const candidate = path.join(path.dirname(ffmpeg), "ffprobe.exe");
  try {
    accessSync(candidate, constants.F_OK);
    return candidate;
  } catch {
    return null;
  }
}

function probeDuration(ffmpeg, input, control) {
  return new Promise((resolve) => {
    if (control.stopped()) {
      resolve(0);
      return;
    }
    const ffprobe = findFfprobe(ffmpeg);
    const child = spawn(
      ffprobe ?? ffmpeg,
      ffprobe
        ? ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]
        : ["-hide_banner", "-nostdin", "-probesize", "5000000", "-analyzeduration", "1000000", "-i", input],
      { windowsHide: true },
    );
    control.attach(child);
    let text = "";
    const collect = (chunk) => {
      text += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("close", () => {
      if (control.stopped()) {
        resolve(0);
        return;
      }
      if (ffprobe) {
        const seconds = Number.parseFloat(text.trim().split(/\r?\n/).pop());
        resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
        return;
      }
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      resolve(match ? parseClock(`${match[1]}:${match[2]}:${match[3]}`) ?? 0 : 0);
    });
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
      .then(async (duration) => {
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
        const hardware = await detectHardware(ffmpeg);
        if (stopRequested) {
          finish(reject, stoppedError());
          return;
        }
        const launch = (useHardware) => {
          if (stopRequested) {
            finish(reject, stoppedError());
            return;
          }
          const child = spawn(
            ffmpeg,
            [
              "-hide_banner",
              "-nostdin",
              "-threads",
              "0",
              "-y",
              "-i",
              input,
              "-map",
              "0:v:0",
              "-map",
              "0:a:0?",
              "-sn",
              ...codecArgs(target, useHardware ? hardware : null),
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
          const closeLines = () => {
            lines.close();
          };
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
            closeLines();
            finish(reject, error);
          });
          child.on("close", (code) => {
            closeLines();
            if (stopRequested) {
              finish(reject, stoppedError());
              return;
            }
            if (code === 0) {
              onProgress(100);
              finish(resolve);
              return;
            }
            if (useHardware && hardware) {
              disableHardware(ffmpeg);
              launch(false);
              return;
            }
            const detail = stderr.trim().split(/\r?\n/).slice(-6).join(" ");
            finish(reject, new Error(detail || `ffmpeg 退出码 ${code}`));
          });
        };
        launch(Boolean(hardware));
      })
      .catch(reject);
  });
}
