import type { Annotation } from "@/lib/editor-types"

export type ExportMode = "stream-copy" | "encode"
export type ExportScope = "timeline" | "selected" | "all"
export type ExportFormat = "mp4" | "mov" | "mkv" | "webm"
export type VideoCodec = "copy" | "h264" | "h265" | "av1" | "vp9"
export type AudioCodec = "copy" | "aac" | "opus" | "mp3"

export type ExportClip = {
  sourceStart?: number
  id: string
  label: string
  startTime: number
  endTime: number
}

export type ExportSettings = {
  format: ExportFormat
  mode: ExportMode
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  videoBitrateKbps: number | null
  audioBitrateKbps: number | null
  fps: number | null
  width: number | null
  height: number | null
  crf: number | null
  preset: string
}

export type ExportTrimRequest = {
  timeline?: boolean
  inputPath: string
  outputPath: string
  clips: ExportClip[]
  annotations?: Annotation[]
  settings: ExportSettings
}

export type ExportProgressEvent = {
  operationId: string
  progress: number
  status?: "exporting" | "completed" | "failed" | "cancelled"
  message?: string
}

export type ExportStarted = {
  operationId: string
  outputPath: string
}
