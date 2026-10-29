import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pickOutputFolder, pickVideoFiles } from "./dialogs.mjs";
import { allocateOutputs, convertFile, detectHardware, findFfmpeg, matchesSource, outputExtension } from "./convert.mjs";
import { resumeProcess, suspendProcess, warmProcessControl } from "./process-control.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.resolve(rootDir, "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeDistPath(pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const filePath = path.resolve(distDir, rel);
  if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) return null;
  return filePath;
}

async function serveStatic(res, pathname) {
  const filePath = safeDistPath(pathname);
  if (!filePath) {
    send(res, 403, { error: "禁止访问" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch {
    if (path.extname(filePath)) {
      send(res, 404, { error: "找不到文件" });
      return;
    }
    try {
      const html = await readFile(path.join(distDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      send(res, 404, { error: "界面还没有打包。请先在项目目录运行 npm run build:web" });
    }
  }
}

const PORT = Number(process.env.PORT) || 3927;
const CONVERT_SLOTS = 3;
const jobs = new Map();
let activeJobId = null;
let currentJobId = null;

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求不是有效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isLocalPath(value) {
  return typeof value === "string" && /^([a-zA-Z]:[\\/]|\\\\)/.test(value) && !value.includes("\0");
}

async function describeFile(filePath) {
  const info = await stat(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: info.size,
    ext: path.extname(filePath).toLowerCase(),
  };
}

function partialOutput(output) {
  return path.join(path.dirname(output), ".converting", path.basename(output));
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    sourceType: job.sourceType,
    targetType: job.targetType,
    outputDir: job.outputDir,
    files: job.files.map((file) => ({
      input: file.input,
      name: file.name,
      output: file.output,
      progress: file.progress,
      status: file.status,
      error: file.error,
      skipped: file.skipped || undefined,
      pausedFrom: file.pausedFrom,
      size: file.size,
    })),
  };
}

function notify(job) {
  job.wakeId = (job.wakeId ?? 0) + 1;
  const waiters = job.waiters ?? [];
  job.waiters = [];
  for (const resolve of waiters) resolve();
}

function waitForChange(job) {
  const token = job.wakeId ?? 0;
  return new Promise((resolve) => {
    if ((job.wakeId ?? 0) !== token) {
      resolve();
      return;
    }
    if (!job.waiters) job.waiters = [];
    job.waiters.push(resolve);
  });
}

function refreshJobRunState(job) {
  if (job.status === "cancelled" || job.status === "done") return;
  const active = job.files.some((file) => file.status === "pending" || file.status === "converting");
  const paused = job.files.some((file) => file.status === "paused");
  if (!active && paused) job.status = "paused";
  else if (active) job.status = "running";
}

function withFileLock(file, task) {
  const previous = file.lock ?? Promise.resolve();
  const next = previous.then(task, task);
  file.lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function ensureSuspended(file) {
  if (!file.encoderPid || file.suspended || file.settled) return;
  try {
    await suspendProcess(file.encoderPid);
  } catch (error) {
    if (file.settled) return;
    throw error;
  }
  if (file.settled) {
    try {
      await resumeProcess(file.encoderPid);
    } catch {
      // 转换进程已经退出
    }
    return;
  }
  file.suspended = true;
}

async function ensureResumed(file) {
  if (!file.encoderPid || !file.suspended) return;
  await resumeProcess(file.encoderPid);
  file.suspended = false;
}

async function removeEmptyPartialDir(partialDir) {
  if (path.basename(partialDir) !== ".converting") return;
  await rmdir(partialDir).catch(() => undefined);
}

async function discardPart(file) {
  if (!file.part) return;
  const partialDir = path.dirname(file.part);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await unlink(file.part);
      break;
    } catch (error) {
      if (error?.code === "ENOENT") break;
      if (attempt === 9) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await removeEmptyPartialDir(partialDir);
}

async function stopEncoding(file) {
  await withFileLock(file, async () => {
    if (file.suspended && file.encoderPid) {
      try {
        await resumeProcess(file.encoderPid);
      } catch {
        // 挂起的进程仍尝试直接结束
      }
      file.suspended = false;
    }
    file.stop?.();
  });
}

async function pauseFile(job, file) {
  if (file.status === "paused") return;
  if (file.status === "pending") {
    file.status = "paused";
    file.pausedFrom = "pending";
    refreshJobRunState(job);
    return;
  }
  if (file.status !== "converting") throw new Error("这个文件当前不能暂停");
  file.status = "paused";
  file.pausedFrom = "converting";
  file.suspendRequested = !file.encoderPid;
  try {
    await withFileLock(file, () => ensureSuspended(file));
  } catch (error) {
    if (!file.suspended && !file.removed && job.status !== "cancelled" && file.status === "paused") {
      file.status = "converting";
      file.pausedFrom = undefined;
      file.suspendRequested = false;
    }
    throw error;
  }
  refreshJobRunState(job);
}

async function resumeFile(job, file) {
  if (file.status !== "paused") throw new Error("这个文件没有暂停");
  await withFileLock(file, async () => {
    file.suspendRequested = false;
    if (file.pausedFrom === "converting") {
      await ensureResumed(file);
      file.status = "converting";
    } else {
      file.status = "pending";
    }
    file.pausedFrom = undefined;
  });
  refreshJobRunState(job);
  notify(job);
}

async function pauseAll(job) {
  for (const file of job.files) {
    if (file.status === "pending" || file.status === "converting") await pauseFile(job, file);
  }
  refreshJobRunState(job);
  if (job.files.some((file) => file.status === "paused")) job.status = "paused";
  notify(job);
}

async function resumeAll(job) {
  for (const file of job.files) {
    if (file.status === "paused") await resumeFile(job, file);
  }
  refreshJobRunState(job);
  notify(job);
}

async function removeJobFile(job, input) {
  const file = job.files.find((item) => item.input === input);
  if (!file) throw new Error("找不到这个文件");
  file.removed = true;
  const encoding = file.status === "converting" || (file.status === "paused" && file.pausedFrom === "converting");
  if (encoding) await stopEncoding(file);
  job.files = job.files.filter((item) => item.input !== input);
  refreshJobRunState(job);
  notify(job);
}

async function cancelAll(job) {
  job.status = "cancelled";
  for (const file of job.files) {
    if (file.status === "done") continue;
    const encoding = file.status === "converting" || (file.status === "paused" && file.pausedFrom === "converting");
    if (encoding) await stopEncoding(file);
    if (file.status === "pending" || file.status === "paused" || file.status === "converting") file.status = "cancelled";
  }
  notify(job);
}

function requireActiveJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const error = new Error("找不到这个转换任务");
    error.statusCode = 404;
    throw error;
  }
  if (job.status !== "running" && job.status !== "paused") {
    const error = new Error("这个任务已经结束");
    error.statusCode = 409;
    throw error;
  }
  return job;
}

async function prepareSelection(body) {
  const sourceType = body.sourceType;
  const targetType = body.targetType;
  const outputDir = body.outputDir;
  const files = Array.isArray(body.files) ? body.files : [];
  if (!outputExtension(targetType) || !outputExtension(sourceType)) {
    const error = new Error("来源或目标格式不受支持");
    error.statusCode = 400;
    throw error;
  }
  if (!isLocalPath(outputDir)) {
    const error = new Error("请选择本机输出文件夹");
    error.statusCode = 400;
    throw error;
  }
  const directory = await stat(outputDir).catch(() => null);
  if (!directory?.isDirectory()) {
    const error = new Error("输出路径不是文件夹");
    error.statusCode = 400;
    throw error;
  }
  const accepted = files.filter((filePath) => isLocalPath(filePath) && matchesSource(filePath, sourceType));
  if (accepted.length === 0) {
    const error = new Error("没有符合来源格式的视频");
    error.statusCode = 400;
    throw error;
  }
  return {
    sourceType,
    targetType,
    outputDir,
    plans: allocateOutputs(outputDir, accepted, outputExtension(targetType)),
  };
}

async function convertOne(job, ffmpeg, file) {
  file.status = "converting";
  file.progress = 0;
  file.error = undefined;
  file.part = partialOutput(file.output);
  try {
    await mkdir(path.dirname(file.part), { recursive: true });
    await unlink(file.part).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    if (job.status === "cancelled" || file.removed || file.status === "cancelled") {
      await discardPart(file);
      if (!file.removed) file.status = "cancelled";
      return;
    }
    await convertFile(
      ffmpeg,
      file.input,
      file.part,
      job.targetType,
      (progress) => {
        if (file.status === "converting") file.progress = progress;
      },
      {
        bind(api) {
          file.stop = api.stop;
          if (file.removed || job.status === "cancelled" || file.status === "cancelled") api.stop();
        },
        onEncoder(child) {
          file.settled = false;
          file.encoderPid = child.pid ?? null;
          file.encoder = child;
          child.once("close", () => {
            if (file.encoder === child) file.settled = true;
          });
          void withFileLock(file, async () => {
            if (file.removed || job.status === "cancelled" || file.status === "cancelled") {
              file.stop?.();
              return;
            }
            if (file.settled) return;
            if (file.suspendRequested || file.status === "paused" || job.status === "paused") {
              file.suspendRequested = false;
              file.status = "paused";
              file.pausedFrom = "converting";
              try {
                await ensureSuspended(file);
                if (file.settled) {
                  await ensureResumed(file);
                  return;
                }
                refreshJobRunState(job);
              } catch (error) {
                if (file.settled || file.removed || job.status === "cancelled") return;
                file.status = "converting";
                file.pausedFrom = undefined;
                file.error = error instanceof Error ? error.message : "暂停失败";
              }
            }
          });
        },
      },
    );
    if (file.removed || job.status === "cancelled" || file.status === "cancelled") {
      await discardPart(file);
      if (!file.removed && file.status !== "cancelled") file.status = "cancelled";
      return;
    }
    await rename(file.part, file.output);
    await removeEmptyPartialDir(path.dirname(file.part));
    file.status = "done";
    file.progress = 100;
    file.skipped = false;
    file.error = undefined;
  } catch (error) {
    await discardPart(file);
    if (file.removed) return;
    if (error?.stopped || job.status === "cancelled" || file.status === "cancelled") {
      file.status = "cancelled";
      return;
    }
    file.status = "error";
    file.error = error instanceof Error ? error.message : "转换失败";
  } finally {
    file.part = undefined;
    file.encoderPid = null;
    file.suspended = false;
    file.stop = null;
    file.suspendRequested = false;
    notify(job);
  }
}

async function runJob(job, ffmpeg) {
  job.waiters = [];
  job.wakeId = 0;

  async function worker() {
    while (job.status !== "cancelled") {
      if (job.status === "paused") {
        await waitForChange(job);
        continue;
      }
      const file = job.files.find((item) => item.status === "pending");
      if (!file) {
        if (job.files.some((item) => item.status === "paused" || item.status === "converting")) {
          await waitForChange(job);
          continue;
        }
        return;
      }
      file.status = "converting";
      await convertOne(job, ffmpeg, file);
    }
  }

  try {
    await Promise.all(Array.from({ length: CONVERT_SLOTS }, () => worker()));
  } finally {
    if (activeJobId === job.id) activeJobId = null;
    if (job.status === "running" || job.status === "paused") job.status = "done";
    notify(job);
  }
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    send(res, 400, { error: "无效请求" });
    return;
  }
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      send(res, 200, { ok: true, ffmpeg: Boolean(findFfmpeg()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pick-files") {
      const paths = await pickVideoFiles();
      const files = [];
      for (const filePath of paths) {
        files.push(await describeFile(filePath));
      }
      send(res, 200, { files });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pick-folder") {
      const folder = await pickOutputFolder();
      send(res, 200, { path: folder });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/outputs") {
      const body = await readJson(req);
      const selection = await prepareSelection(body);
      send(res, 200, {
        files: selection.plans.map((plan) => ({
          input: plan.input,
          output: plan.output,
          skipped: plan.skipped,
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readJson(req);
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) {
        send(res, 500, { error: "找不到 ffmpeg.exe" });
        return;
      }
      if (activeJobId) {
        send(res, 409, { error: "已有转换任务正在进行" });
        return;
      }
      const selection = await prepareSelection(body);
      const paused = new Set(Array.isArray(body.paused) ? body.paused.filter((item) => typeof item === "string") : []);
      const files = await Promise.all(
        selection.plans.map(async (plan) => {
          const info = await stat(plan.input).catch(() => null);
          const base = {
            input: plan.input,
            name: path.basename(plan.input),
            output: plan.output,
            size: info?.size ?? 0,
          };
          if (plan.skipped) {
            return { ...base, progress: 100, status: "done", skipped: true };
          }
          if (paused.has(plan.input)) {
            return { ...base, progress: 0, status: "paused", pausedFrom: "pending" };
          }
          return { ...base, progress: 0, status: "pending" };
        }),
      );
      const hasPending = files.some((file) => file.status === "pending");
      const hasPaused = files.some((file) => file.status === "paused");
      const job = {
        id: randomUUID(),
        status: hasPending ? "running" : hasPaused ? "paused" : "done",
        sourceType: selection.sourceType,
        targetType: selection.targetType,
        outputDir: selection.outputDir,
        files,
        waiters: [],
        wakeId: 0,
      };
      jobs.set(job.id, job);
      currentJobId = job.id;
      if (job.status !== "done") {
        activeJobId = job.id;
        void runJob(job, ffmpeg);
      }
      send(res, 200, { job: publicJob(job) });
      return;
    }

    const actionMatch = /^\/api\/jobs\/([^/]+)\/(pause|resume|remove|cancel)$/.exec(url.pathname);
    if (req.method === "POST" && actionMatch) {
      const job = requireActiveJob(decodeURIComponent(actionMatch[1]));
      const action = actionMatch[2];
      const body = action === "cancel" ? {} : await readJson(req);
      if (action === "pause") {
        if (body.input) {
          const file = job.files.find((item) => item.input === body.input);
          if (!file) {
            send(res, 404, { error: "找不到这个文件" });
            return;
          }
          await pauseFile(job, file);
        } else {
          await pauseAll(job);
        }
      } else if (action === "resume") {
        if (body.input) {
          const file = job.files.find((item) => item.input === body.input);
          if (!file) {
            send(res, 404, { error: "找不到这个文件" });
            return;
          }
          await resumeFile(job, file);
        } else {
          await resumeAll(job);
        }
      } else if (action === "remove") {
        if (typeof body.input !== "string" || !body.input) {
          send(res, 400, { error: "请指定要删除的文件" });
          return;
        }
        await removeJobFile(job, body.input);
      } else {
        await cancelAll(job);
      }
      send(res, 200, { job: publicJob(job) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs/current") {
      const job = currentJobId ? jobs.get(currentJobId) : null;
      send(res, 200, { job: job ? publicJob(job) : null });
      return;
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) {
        send(res, 404, { error: "找不到这个转换任务" });
        return;
      }
      send(res, 200, { job: publicJob(job) });
      return;
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api")) {
      await serveStatic(res, url.pathname);
      return;
    }

    send(res, 404, { error: "未找到接口" });
  } catch (error) {
    const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
    send(res, status, { error: error instanceof Error ? error.message : "服务器错误" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const ffmpeg = findFfmpeg();
  console.log(`转换服务已启动：http://127.0.0.1:${PORT}`);
  console.log(ffmpeg ? `ffmpeg：${ffmpeg}` : "未找到 ffmpeg.exe");
  void warmProcessControl().catch(() => {
    // 暂停时会再试一次
  });
  if (ffmpeg) {
    void detectHardware(ffmpeg).then((encoder) => {
      console.log(encoder ? `显卡编码：h264_${encoder}` : "显卡编码不可用，使用软件编码");
    });
  }
});
