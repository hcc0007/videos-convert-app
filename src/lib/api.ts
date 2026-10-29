export const API_BASE = "http://127.0.0.1:3927";

export type PickedFile = {
  path: string;
  name: string;
  size: number;
  ext: string;
};

export type JobFileStatus = "pending" | "converting" | "paused" | "done" | "error" | "cancelled";

export type JobFile = {
  input: string;
  name: string;
  output: string;
  progress: number;
  status: JobFileStatus;
  error?: string;
  skipped?: boolean;
  pausedFrom?: "pending" | "converting";
  size?: number;
};

export type Job = {
  id: string;
  status: "running" | "paused" | "done" | "cancelled";
  sourceType: string;
  targetType: string;
  outputDir: string;
  files: JobFile[];
};

export type OutputPlan = {
  input: string;
  output: string;
  skipped: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  return body;
}

export function checkHealth() {
  return request<{ ok: boolean; ffmpeg: boolean }>("/api/health");
}

export function pickFiles() {
  return request<{ files: PickedFile[] }>("/api/pick-files", { method: "POST" });
}

export function pickFolder() {
  return request<{ path: string }>("/api/pick-folder", { method: "POST" });
}

export function checkOutputs(input: { files: string[]; sourceType: string; targetType: string; outputDir: string }) {
  return request<{ files: OutputPlan[] }>("/api/outputs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function startJob(input: {
  files: string[];
  sourceType: string;
  targetType: string;
  outputDir: string;
  paused?: string[];
}) {
  return request<{ job: Job }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getJob(id: string) {
  return request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
}

export function getCurrentJob() {
  return request<{ job: Job | null }>("/api/jobs/current");
}

export function pauseJob(id: string, input?: string) {
  return request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/pause`, {
    method: "POST",
    body: JSON.stringify(input ? { input } : {}),
  });
}

export function resumeJob(id: string, input?: string) {
  return request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: JSON.stringify(input ? { input } : {}),
  });
}

export function removeJobFile(id: string, input: string) {
  return request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/remove`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export function cancelJob(id: string) {
  return request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
