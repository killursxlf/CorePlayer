export type MediaProbe = {
  duration: number
  codec?: string
  resolution?: string
  fps?: number
  timeBase?: string
  rotation?: number
  hasAudio?: boolean
  variableFps?: boolean
  bitrate?: string
  audioStreams?: string
  subtitles?: string
}

export type OpenMediaResult = {
  originalPath: string
  playbackUrl: string
  fileName: string
  probe: MediaProbe
}

export type TimelineThumbnail = {
  time: number
  url: string
}

export type AudioWaveformRequest = {
  videoId: string
  filePath: string
  duration: number
  peakCount: number
}

export type AudioWaveformResult = {
  videoId: string
  duration: number
  peaks: number[]
}

export type ThumbnailState = "queued" | "loading" | "ready" | "error" | "missing" | "cache-corrupt"

export type ThumbnailRequest = {
  videoId: string
  filePath: string
  startTime: number
  endTime: number
  intervalSeconds: number
  thumbnailWidth: number
  generation: number
}

export type ThumbnailResult = {
  videoId: string
  generation: number
  intervalSeconds: number
  cacheDir: string
  thumbnails: Array<{
    time: number
    path: string
    state: ThumbnailState
    error?: string
  }>
}

export type MediaState = {
  originalPath: string | null
  playbackUrl: string | null
  fileName: string | null

  duration: number
  currentTime: number
  volume: number
  playbackRate: number

  isPlaying: boolean
  isLoading: boolean

  trimStart: number
  trimEnd: number | null

  exportProgress: number
  exportStatus: ExportStatus

  error: import("./app-error").AppError | null
}

export type ExportStatus = "idle" | "preparing" | "exporting" | "completed" | "failed" | "cancelled"
