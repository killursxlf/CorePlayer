import type { ExportProgressHandler, MediaService } from "@/services/media-service"
import type { ExportTrimRequest } from "@/types/export"
import type {
  AudioWaveformRequest,
  AudioWaveformResult,
  MediaProbe,
  OpenMediaResult,
  ThumbnailRequest,
  ThumbnailResult,
  HardwareProfile,
  PerformancePreset,
  RuntimeMetrics,
  RuntimePerformanceConfig,
  TaskBudget,
} from "@/types/media"

const mockBudget: TaskBudget = {
  allowed: true,
  cpuThreads: 1,
  filterThreads: 1,
  maxParallelJobs: 1,
  batchSize: 3,
  maxChunkSeconds: 12,
  prefetchAllowed: true,
  delayMs: 20,
  ramCacheBytes: 128 * 1024 * 1024,
  decodeConcurrency: 2,
  cancelLowPriority: false,
  reason: "mock",
}

const mockHardware: HardwareProfile = {
  logicalCpus: 4,
  powerClass: "medium",
  operatingSystem: "mock",
  storageClass: "conservative-unknown",
  hardwareDecodeAvailable: false,
}

let mockPreset: PerformancePreset = "auto"

function mockRuntimeConfig(droppedFrameRatio = 0): RuntimePerformanceConfig {
  return {
    hardware: mockHardware,
    preset: mockPreset,
    pressure: droppedFrameRatio > 0.03 ? "high" : "normal",
    playbackActive: false,
    exportActive: false,
    droppedFrameRatio,
    cpuLoad: 0,
    activeBackgroundTasks: 0,
    thumbnailBudget: mockBudget,
    waveformBudget: mockBudget,
  }
}

const mockProbe: MediaProbe = {
  duration: 214,
  codec: "H.264 / AVC",
  resolution: "1920 x 1080",
  fps: 30,
  bitrate: "24 Mbps",
  audioStreams: "1 - Stereo AAC",
  subtitles: "None",
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export const mockMediaService: MediaService = {
  async openMedia(): Promise<OpenMediaResult | null> {
    const originalPath = "C:\\Videos\\summit_ascent_final.mp4"
    return {
      originalPath,
      playbackUrl: "/images/preview-frame.png",
      fileName: fileNameFromPath(originalPath),
      probe: mockProbe,
    }
  },

  async closeMedia(): Promise<void> {
    return undefined
  },

  async probeMedia(): Promise<MediaProbe> {
    return mockProbe
  },

  async preparePlayback(): Promise<string> {
    return "/images/preview-frame.png"
  },

  async createVideoCacheId(): Promise<string> {
    return "mock-video"
  },

  async generateTimelineThumbnailRange(request: ThumbnailRequest): Promise<ThumbnailResult> {
    const thumbnails = []
    for (let time = request.startTime; time <= request.endTime; time += request.intervalSeconds) {
      thumbnails.push({
        time: Math.round(time * 1000) / 1000,
        path: "/images/preview-frame.png",
        state: "ready" as const,
      })
    }

    return {
      videoId: request.videoId,
      generation: request.generation,
      intervalSeconds: request.intervalSeconds,
      cacheDir: "mock://thumbnail-cache",
      thumbnails,
    }
  },

  async generateAudioWaveform(request: AudioWaveformRequest): Promise<AudioWaveformResult> {
    return {
      videoId: request.videoId,
      startTime: request.startTime,
      endTime: request.endTime,
      peaks: Array.from({ length: request.peakCount }, (_, index) => {
        const time = index / Math.max(1, request.peakCount - 1)
        return Math.min(1, 0.15 + Math.abs(Math.sin(time * 34)) * 0.55 + Math.abs(Math.cos(time * 93)) * 0.3)
      }),
    }
  },

  async cancelBackgroundMedia(): Promise<void> {
    return undefined
  },

  async setMediaPlaybackState(): Promise<void> {
    return undefined
  },

  async getHardwareProfile(): Promise<HardwareProfile> {
    return mockHardware
  },

  async getRuntimePerformanceConfig(): Promise<RuntimePerformanceConfig> {
    return mockRuntimeConfig()
  },

  async setPerformancePreset(preset: PerformancePreset): Promise<void> {
    mockPreset = preset
  },

  async updateRuntimeMetrics(metrics: RuntimeMetrics): Promise<RuntimePerformanceConfig> {
    return mockRuntimeConfig(metrics.droppedFrameRatio)
  },

  async getMediaTaskBudget(): Promise<TaskBudget> {
    return mockBudget
  },

  async exportTrim(
    request: ExportTrimRequest,
    onProgress?: ExportProgressHandler,
  ): Promise<{ operationId: string; outputPath: string }> {
    const operationId = crypto.randomUUID()
    onProgress?.({
      operationId,
      progress: 1,
      message: request.annotations?.length
        ? `Mock export completed with ${request.annotations.length} overlay annotations`
        : "Mock export completed",
    })
    return { operationId, outputPath: request.outputPath || `mock-export.${request.settings.format}` }
  },

  async cancelOperation(): Promise<void> {
    return undefined
  },
}
