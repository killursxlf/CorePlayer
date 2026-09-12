import type { ExportSettings } from "@/types/export"

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "mp4", mode: "encode", videoCodec: "h264", audioCodec: "aac",
  videoBitrateKbps: null, audioBitrateKbps: 192, fps: null, width: null,
  height: null, crf: 20, preset: "medium",
}

export function compatibleExportSettings(settings: ExportSettings): ExportSettings {
  if (settings.format !== "webm") return settings
  return {
    ...settings, mode: "encode",
    videoCodec: settings.videoCodec === "av1" ? "av1" : "vp9",
    audioCodec: "opus",
  }
}
