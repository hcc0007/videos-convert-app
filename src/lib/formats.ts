export type VideoFormat = {
  id: string;
  label: string;
  extensions: string[];
  outputExtension: string;
};

export const VIDEO_FORMATS: VideoFormat[] = [
  { id: "mp4", label: "MP4", extensions: [".mp4", ".m4v"], outputExtension: ".mp4" },
  { id: "avi", label: "AVI", extensions: [".avi"], outputExtension: ".avi" },
  { id: "mkv", label: "MKV", extensions: [".mkv"], outputExtension: ".mkv" },
  { id: "mov", label: "MOV", extensions: [".mov"], outputExtension: ".mov" },
  { id: "webm", label: "WebM", extensions: [".webm"], outputExtension: ".webm" },
  { id: "flv", label: "FLV", extensions: [".flv"], outputExtension: ".flv" },
  { id: "wmv", label: "WMV", extensions: [".wmv"], outputExtension: ".wmv" },
  { id: "mpeg", label: "MPEG", extensions: [".mpg", ".mpeg"], outputExtension: ".mpg" },
];

export function formatById(id: string | undefined) {
  return VIDEO_FORMATS.find((format) => format.id === id);
}

export function extensionOf(filePath: string) {
  const match = /\.[^.\\/]+$/.exec(filePath);
  return match ? match[0].toLowerCase() : "";
}

export function matchesFormat(filePath: string, formatId: string | undefined) {
  const format = formatById(formatId);
  if (!format) return false;
  return format.extensions.includes(extensionOf(filePath));
}
