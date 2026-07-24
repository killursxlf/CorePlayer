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

export type PlaybackRegistration = {
  mediaId: string
  streamUrl: string
  fileSize: number
  mimeType: string
}

export type AudioWaveformRequest = {
  videoId: string
  filePath: string
  startTime: number
  endTime: number
  peakCount: number
}

export type AudioWaveformResult = {
  videoId: string
  startTime: number
  endTime: number
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
  thumbnailHeight: number
  generation: number
  priority: "visible" | "near" | "prefetch"
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

export type PerformancePreset = "auto" | "powerSaver" | "balanced" | "performance" | "custom"
export type PressureLevel = "normal" | "elevated" | "high" | "critical"
export type MediaTaskKind =
  | "visibleThumbnail"
  | "nearThumbnail"
  | "thumbnailPrefetch"
  | "visibleWaveform"
  | "fullWaveform"
  | "proxy"
  | "export"

export type HardwareProfile = {
  logicalCpus: number
  powerClass: string
  operatingSystem: string
  storageClass: string
  totalRamBytes?: number
  availableRamBytes?: number
  onBattery?: boolean
  hardwareDecodeAvailable: boolean
}

export type TaskBudget = {
  allowed: boolean
  cpuThreads: number
  filterThreads: number
  maxParallelJobs: number
  batchSize: number
  maxChunkSeconds: number
  prefetchAllowed: boolean
  delayMs: number
  ramCacheBytes: number
  decodeConcurrency: number
  cancelLowPriority: boolean
  reason: string
}

export type RuntimePerformanceConfig = {
  hardware: HardwareProfile
  preset: PerformancePreset
  pressure: PressureLevel
  playbackActive: boolean
  exportActive: boolean
  droppedFrameRatio: number
  cpuLoad?: number
  activeBackgroundTasks: number
  thumbnailBudget: TaskBudget
  waveformBudget: TaskBudget
}

export type RuntimeMetrics = {
  droppedFrameRatio: number
  userActive: boolean
  windowVisible: boolean
}
