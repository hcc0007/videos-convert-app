import { FolderOpen, Video } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  cancelJob,
  checkHealth,
  checkOutputs,
  getJob,
  pauseJob,
  pickFiles,
  pickFolder,
  removeJobFile,
  resumeJob,
  startJob,
  type Job,
  type JobFile,
  type OutputPlan,
  type PickedFile,
} from "../lib/api";
import { matchesFormat, VIDEO_FORMATS, formatById } from "../lib/formats";
import { cn } from "../lib/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { FormatSelect } from "./ui/select";
import { Progress } from "./ui/progress";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fileNameOf(filePath: string) {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

function statusLabel(task: JobFile) {
  if (task.status === "done" && task.skipped) return "已转换";
  if (task.status === "done") return "已完成";
  if (task.status === "converting") return `转换中 ${Math.round(task.progress)}%`;
  if (task.status === "paused") return "已暂停";
  if (task.status === "pending") return "等待中";
  if (task.status === "cancelled") return "已取消";
  return "失败";
}

function ActionButton({
  label,
  onPress,
  disabled,
  tone = "default",
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "danger" | "primary";
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      className={cn(
        "h-12 flex-1 items-center justify-center rounded-xl border px-3",
        tone === "primary" && "border-pine bg-pine active:bg-pineDeep",
        tone === "danger" && "border-[#e7c7c7] bg-white active:bg-[#fff6f6]",
        tone === "default" && "border-line bg-white active:bg-paper",
        disabled && "opacity-40",
      )}
    >
      <Text
        className={cn(
          "text-base font-semibold",
          tone === "primary" && "text-white",
          tone === "danger" && "text-[#9f2d2d]",
          tone === "default" && "text-ink",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ConvertScreen() {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sourceType, setSourceType] = useState<string>();
  const [targetType, setTargetType] = useState<string>();
  const [outputDir, setOutputDir] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [busy, setBusy] = useState<"files" | "folder" | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [serverReady, setServerReady] = useState(true);
  const [ffmpegReady, setFfmpegReady] = useState(true);
  const [existing, setExisting] = useState<Record<string, string>>({});
  const [held, setHeld] = useState<string[]>([]);
  const jobRef = useRef<Job | null>(null);

  const jobActive = job?.status === "running" || job?.status === "paused";
  const source = formatById(sourceType);
  const matchingFiles = useMemo(
    () => files.filter((file) => matchesFormat(file.path, sourceType)),
    [files, sourceType],
  );
  const matchingKey = matchingFiles.map((file) => file.path).join("\n");

  function applyJob(next: Job) {
    const previous = jobRef.current;
    jobRef.current = next;
    setJob(next);
    const finished = next.status === "done" && next.files.length > 0;
    const newlyFinished = finished && (previous?.id !== next.id || previous.status !== "done");
    if (newlyFinished) setDoneOpen(true);
  }

  function rememberOutputs(plans: OutputPlan[]) {
    const next: Record<string, string> = {};
    for (const item of plans) {
      if (item.skipped) next[item.input] = item.output;
    }
    setExisting(next);
    return next;
  }

  useEffect(() => {
    checkHealth()
      .then((health) => {
        setServerReady(health.ok);
        setFfmpegReady(health.ffmpeg);
      })
      .catch(() => {
        setServerReady(false);
        setFfmpegReady(false);
      });
  }, []);

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus === "done" || jobStatus === "cancelled") return;
    const timer = setInterval(() => {
      getJob(jobId)
        .then((result) => applyJob(result.job))
        .catch((reason: Error) => setError(reason.message));
    }, 400);
    return () => clearInterval(timer);
  }, [jobId, jobStatus]);

  useEffect(() => {
    if (!outputDir || !sourceType || !targetType || matchingFiles.length === 0) {
      setExisting({});
      return;
    }
    let ignore = false;
    checkOutputs({
      files: matchingFiles.map((file) => file.path),
      sourceType,
      targetType,
      outputDir,
    })
      .then((result) => {
        if (!ignore) rememberOutputs(result.files);
      })
      .catch(() => {
        if (!ignore) setExisting({});
      });
    return () => {
      ignore = true;
    };
  }, [outputDir, sourceType, targetType, matchingKey, jobStatus]);

  function isAlreadyConverted(filePath: string) {
    return Boolean(existing[filePath]);
  }

  const alreadyCount = matchingFiles.filter((file) => isAlreadyConverted(file.path)).length;
  const heldCount = matchingFiles.filter((file) => !isAlreadyConverted(file.path) && held.includes(file.path)).length;
  const convertibleCount = matchingFiles.length - alreadyCount - heldCount;
  const showResumeAll = job?.status === "paused" || (!jobActive && heldCount > 0 && convertibleCount === 0);
  const canPauseAll =
    (job?.status === "running" && job.files.some((file) => file.status === "pending" || file.status === "converting")) ||
    (!jobActive && convertibleCount > 0);
  const canResumeAll = showResumeAll;
  const canToggleAll = canPauseAll || canResumeAll;

  const blockedReason = !serverReady
    ? "转换服务未就绪，请在项目目录运行 npm start。"
    : !ffmpegReady
      ? "找不到 ffmpeg.exe，无法转换视频。"
      : files.length === 0
        ? "请先选择视频文件。"
        : !sourceType
          ? "请选择来源视频类型。"
          : !targetType
            ? "请选择要转换的视频类型。"
            : !outputDir
              ? "请选择转换后的保存路径。"
              : matchingFiles.length === 0
                ? `所选文件里没有 ${source?.label ?? ""} 视频。`
                : convertibleCount === 0 && alreadyCount === matchingFiles.length
                  ? "这些视频已经转换过了，不会重复转换。"
                  : convertibleCount === 0
                    ? "要转换的视频都已暂停。"
                    : "";

  async function runAction(task: () => Promise<void>) {
    if (acting) return;
    setActing(true);
    setError("");
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActing(false);
    }
  }

  async function onPickFiles() {
    setError("");
    setBusy("files");
    try {
      const result = await pickFiles();
      setFiles((current) => {
        const known = new Set(current.map((file) => file.path.toLowerCase()));
        const next = result.files.filter((file) => !known.has(file.path.toLowerCase()));
        return [...current, ...next];
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "选择文件失败");
    } finally {
      setBusy(null);
    }
  }

  async function onPickFolder() {
    setError("");
    setBusy("folder");
    try {
      const result = await pickFolder();
      if (result.path) setOutputDir(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "选择文件夹失败");
    } finally {
      setBusy(null);
    }
  }

  async function onStart() {
    if (blockedReason || jobActive || acting) return;
    setError("");
    setDoneOpen(false);
    setActing(true);
    try {
      const checked = await checkOutputs({
        files: matchingFiles.map((file) => file.path),
        sourceType: sourceType!,
        targetType: targetType!,
        outputDir,
      });
      const converted = rememberOutputs(checked.files);
      const paused = matchingFiles
        .filter((file) => held.includes(file.path) && !converted[file.path])
        .map((file) => file.path);
      const todo = matchingFiles.filter((file) => !converted[file.path] && !paused.includes(file.path));
      if (todo.length === 0) {
        setError(Object.keys(converted).length > 0 ? "这些视频已经转换过了，不会重复转换。" : "要转换的视频都已暂停。");
        return;
      }
      const result = await startJob({
        files: matchingFiles.map((file) => file.path),
        sourceType: sourceType!,
        targetType: targetType!,
        outputDir,
        paused,
      });
      setHeld([]);
      applyJob(result.job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法开始转换");
    } finally {
      setActing(false);
    }
  }

  function taskFor(filePath: string) {
    if (!job || job.targetType !== targetType || job.outputDir !== outputDir) return undefined;
    return job.files.find((item) => item.input === filePath);
  }

  function onToggleFile(file: PickedFile) {
    const task = taskFor(file.path);
    void runAction(async () => {
      if (jobActive && job && task && (task.status === "pending" || task.status === "converting" || task.status === "paused")) {
        const result =
          task.status === "paused" ? await resumeJob(job.id, file.path) : await pauseJob(job.id, file.path);
        applyJob(result.job);
        return;
      }
      setHeld((current) =>
        current.includes(file.path) ? current.filter((item) => item !== file.path) : [...current, file.path],
      );
    });
  }

  function onDeleteFile(file: PickedFile) {
    void runAction(async () => {
      if (jobActive && job?.files.some((item) => item.input === file.path)) {
        applyJob((await removeJobFile(job.id, file.path)).job);
      }
      setFiles((current) => current.filter((item) => item.path !== file.path));
      setHeld((current) => current.filter((item) => item !== file.path));
    });
  }

  function onToggleAll() {
    void runAction(async () => {
      if (jobActive && job) {
        applyJob((await (showResumeAll ? resumeJob(job.id) : pauseJob(job.id))).job);
        return;
      }
      if (showResumeAll) {
        setHeld([]);
        return;
      }
      setHeld(matchingFiles.filter((file) => !isAlreadyConverted(file.path)).map((file) => file.path));
    });
  }

  function onCancelAll() {
    if (!jobActive || !job) return;
    void runAction(async () => {
      applyJob((await cancelJob(job.id)).job);
    });
  }

  const skippedCount = job?.files.filter((file) => file.status === "done" && file.skipped).length ?? 0;
  const doneCount = job?.files.filter((file) => file.status === "done" && !file.skipped).length ?? 0;
  const failedCount = job?.files.filter((file) => file.status === "error").length ?? 0;
  const doneSummary = [
    doneCount > 0 ? `新转换 ${doneCount} 个` : "",
    skippedCount > 0 ? `跳过已转换 ${skippedCount} 个` : "",
    failedCount > 0 ? `失败 ${failedCount} 个` : "",
  ]
    .filter(Boolean)
    .join("，");

  return (
    <ScrollView className="flex-1 bg-paper" contentContainerStyle={{ flexGrow: 1 }}>
      <View className="mx-auto w-full max-w-3xl px-5 py-8">
        <View className="mb-6">
          <Text className="text-xs tracking-widest text-muted">CONVERT VIDEOS</Text>
          <Text className="mt-1 text-3xl font-semibold text-ink">视频转换</Text>
          <Text className="mt-2 text-base leading-6 text-muted">
            选择多个视频，指定来源格式、目标格式和输出文件夹，然后开始转换。已经转换过的文件会自动跳过。
          </Text>
        </View>

        {!serverReady ? (
          <View className="mb-4 rounded-xl border border-[#e7c7c7] bg-[#fff6f6] px-4 py-3">
            <Text className="text-sm leading-5 text-[#9f2d2d]">
              没有连上本机转换服务。请在项目目录运行 npm start。
            </Text>
          </View>
        ) : !ffmpegReady ? (
          <View className="mb-4 rounded-xl border border-[#e7c7c7] bg-[#fff6f6] px-4 py-3">
            <Text className="text-sm leading-5 text-[#9f2d2d]">找不到 ffmpeg.exe，无法转换视频。</Text>
          </View>
        ) : null}

        <View className="mb-4 rounded-2xl border border-line bg-card p-4">
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-semibold text-ink">视频文件</Text>
            <Text className="text-sm text-muted">{files.length} 个</Text>
          </View>
          <Pressable
            disabled={jobActive || busy !== null}
            onPress={onPickFiles}
            className="mb-3 h-11 flex-row items-center justify-center rounded-xl border border-pine bg-white active:bg-paper disabled:opacity-50"
          >
            <Video size={18} color="#0f6e56" />
            <Text className="ml-2 text-base font-medium text-pine">
              {busy === "files" ? "请在弹出的窗口中选择…" : "选择视频文件"}
            </Text>
          </Pressable>

          {files.length === 0 ? (
            <View className="items-center rounded-xl bg-paper px-4 py-8">
              <Text className="text-base text-muted">还没有选择视频</Text>
            </View>
          ) : (
            files.map((file) => {
              const matched = !sourceType || matchesFormat(file.path, sourceType);
              const task = taskFor(file.path);
              const convertedPath = existing[file.path];
              const fileHeld = held.includes(file.path);
              const canControlTask =
                jobActive && !!task && (task.status === "pending" || task.status === "converting" || task.status === "paused");
              const pauseLabel = !matched || (convertedPath && !canControlTask)
                ? null
                : canControlTask
                  ? task?.status === "paused"
                    ? "继续"
                    : "暂停"
                  : jobActive
                    ? null
                    : fileHeld
                      ? "继续"
                      : "暂停";
              return (
                <View key={file.path} className="mb-2 rounded-xl border border-line px-3 py-3">
                  <View className="flex-row items-start">
                    <View className="mr-3 mt-0.5 h-9 w-9 items-center justify-center rounded-lg bg-paper">
                      <Video size={16} color="#1c1915" />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-base font-medium text-ink" numberOfLines={1}>
                        {file.name}
                      </Text>
                      <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
                        {file.path}
                      </Text>
                      <Text className="mt-1 text-xs text-muted">
                        {formatBytes(file.size)}
                        {file.ext ? ` · ${file.ext.replace(".", "").toUpperCase()}` : ""}
                        {!matched ? " · 与来源格式不符" : ""}
                      </Text>
                    </View>
                  </View>
                  {task ? (
                    <View className="mt-3">
                      <View className="mb-1 flex-row items-center justify-between">
                        <Text
                          className={
                            task.status === "error"
                              ? "text-xs text-[#9f2d2d]"
                              : task.status === "done"
                                ? "text-xs text-pine"
                                : "text-xs text-muted"
                          }
                        >
                          {statusLabel(task)}
                          {task.status === "converting" ? "" : task.status === "paused" ? ` ${Math.round(task.progress)}%` : ""}
                          {task.status === "done" ? ` · ${fileNameOf(task.output)}` : ""}
                        </Text>
                        <Text className="text-xs text-muted">{Math.round(task.progress)}%</Text>
                      </View>
                      <Progress
                        value={task.progress}
                        indicatorClassName={
                          task.status === "error" ? "bg-[#9f2d2d]" : task.status === "paused" ? "bg-[#8a8175]" : undefined
                        }
                      />
                      {task.error ? (
                        <Text className="mt-1 text-xs leading-4 text-[#9f2d2d]" numberOfLines={3}>
                          {task.error}
                        </Text>
                      ) : null}
                    </View>
                  ) : convertedPath ? (
                    <Text className="mt-2 text-xs text-pine">已转换 · {fileNameOf(convertedPath)}，不会重复转换</Text>
                  ) : fileHeld && matched ? (
                    <Text className="mt-2 text-xs text-muted">已暂停，开始转换时会跳过</Text>
                  ) : null}
                  <View className="mt-3 flex-row gap-2">
                    {pauseLabel ? (
                      <Pressable
                        disabled={acting}
                        onPress={() => onToggleFile(file)}
                        accessibilityLabel={pauseLabel === "继续" ? "继续转换" : "暂停转换"}
                        className="h-9 min-w-[76px] items-center justify-center rounded-lg border border-line bg-white px-3 active:bg-paper disabled:opacity-40"
                      >
                        <Text className="text-sm font-medium text-ink">{pauseLabel}</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      disabled={acting}
                      onPress={() => onDeleteFile(file)}
                      accessibilityLabel="删除转换进程"
                      className="h-9 min-w-[76px] items-center justify-center rounded-lg border border-[#e7c7c7] bg-white px-3 active:bg-[#fff6f6] disabled:opacity-40"
                    >
                      <Text className="text-sm font-medium text-[#9f2d2d]">删除</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View className="mb-4 rounded-2xl border border-line bg-card p-4">
          <Text className="mb-3 text-lg font-semibold text-ink">转换设置</Text>
          <View className="gap-3 md:flex-row">
            <View className="flex-1">
              <Text className="mb-1.5 text-sm text-muted">来源视频类型</Text>
              <FormatSelect
                value={sourceType}
                onChange={setSourceType}
                placeholder="选择来源格式"
                disabled={jobActive}
              />
            </View>
            <View className="flex-1">
              <Text className="mb-1.5 text-sm text-muted">要转换成的类型</Text>
              <FormatSelect
                value={targetType}
                onChange={setTargetType}
                placeholder="选择目标格式"
                disabled={jobActive}
              />
            </View>
          </View>
          <Text className="mb-1.5 mt-3 text-sm text-muted">转换后保存到</Text>
          <Pressable
            disabled={jobActive || busy !== null}
            onPress={onPickFolder}
            className="min-h-12 flex-row items-center rounded-xl border border-line bg-white px-3 py-2 active:bg-paper disabled:opacity-50"
          >
            <FolderOpen size={18} color="#0f6e56" />
            <Text className={outputDir ? "ml-2 flex-1 text-base text-ink" : "ml-2 flex-1 text-base text-muted"}>
              {busy === "folder" ? "请在弹出的窗口中选择…" : outputDir || "选择输出文件夹"}
            </Text>
          </Pressable>
          {sourceType && targetType ? (
            <Text className="mt-3 text-sm leading-6 text-muted">
              将把 {convertibleCount} 个 {source?.label} 文件转换为 {formatById(targetType)?.label}
              {alreadyCount > 0 ? `，跳过 ${alreadyCount} 个已转换文件` : ""}
              {heldCount > 0 ? `，${heldCount} 个已暂停` : ""}。
            </Text>
          ) : null}
        </View>

        {error ? (
          <View className="mb-4 rounded-xl border border-[#e7c7c7] bg-[#fff6f6] px-4 py-3">
            <Text className="text-sm leading-5 text-[#9f2d2d]">{error}</Text>
          </View>
        ) : null}

        <Pressable
          disabled={Boolean(blockedReason) || jobActive || acting}
          onPress={onStart}
          className={cn(
            "h-12 items-center justify-center rounded-xl bg-pine active:bg-pineDeep",
            (blockedReason || jobActive || acting) && "opacity-40",
          )}
        >
          <Text className="text-base font-semibold text-white">
            {job?.status === "paused" ? "转换已暂停" : jobActive ? "正在转换…" : "开始转换"}
          </Text>
        </Pressable>
        {blockedReason && !jobActive ? (
          <Text className="mt-2 text-center text-sm text-muted">{blockedReason}</Text>
        ) : null}
        <View className="mt-3 flex-row gap-3">
          <ActionButton
            label={showResumeAll ? "全部继续" : "全部暂停"}
            tone={showResumeAll ? "primary" : "default"}
            disabled={!canToggleAll || acting}
            onPress={onToggleAll}
            accessibilityLabel={showResumeAll ? "全部继续转换" : "全部暂停转换"}
          />
          <ActionButton
            label="全部取消"
            tone="danger"
            disabled={!jobActive || acting}
            onPress={onCancelAll}
            accessibilityLabel="全部取消转换"
          />
        </View>
        <Text className="mt-6 text-center text-xs text-muted">
          支持 {VIDEO_FORMATS.map((format) => format.label).join("、")}
        </Text>
      </View>

      <Dialog open={doneOpen} onOpenChange={setDoneOpen}>
        <DialogContent>
          <DialogTitle>
            {doneCount === 0 && skippedCount > 0 && failedCount === 0 ? "都已经转换过了" : "全部转换完毕！"}
          </DialogTitle>
          <DialogDescription>{doneSummary || "没有需要转换的视频。"}</DialogDescription>
          <DialogClose>好的</DialogClose>
        </DialogContent>
      </Dialog>
    </ScrollView>
  );
}
