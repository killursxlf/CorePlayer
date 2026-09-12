import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { ExportProgressHandler, MediaService } from "@/services/media-service"
import type { ExportProgressEvent, ExportStarted, ExportTrimRequest } from "@/types/export"
import type {
  AudioWaveformRequest,
  AudioWaveformResult,
  MediaProbe,
  OpenMediaResult,
  ThumbnailRequest,
  ThumbnailResult,
  HardwareProfile,
  MediaTaskKind,
  PerformancePreset,
  RuntimeMetrics,
  RuntimePerformanceConfig,
  TaskBudget,
  PlaybackRegistration,
  FrameStep,
} from "@/types/media"

const videoExtensions = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"]
const exportExtensions = {
  mp4: "mp4",
  mov: "mov",
  mkv: "mkv",
  webm: "webm",
} as const

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export const tauriMediaService: MediaService = {
  detectAccelerators() { return invoke("detect_accelerators") },
  async setAccelerationSettings(settings) { await invoke("set_acceleration_settings", { settings }) },
  getFrameStep(inputPath: string, time: number, direction: -1 | 1): Promise<FrameStep> {
    return invoke<FrameStep>("get_frame_step", { inputPath, time, direction })
  },
  async cancelFrameSteps(): Promise<void> { await invoke("cancel_frame_steps") },
  async openMedia(): Promise<OpenMediaResult | null> {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Open Video or Audio",
      filters: [{ name: "Video and audio", extensions: videoExtensions }],
    })

    if (typeof selected !== "string") return null

    const probe = await tauriMediaService.probeMedia(selected)
    return {
      originalPath: selected,
      playbackUrl: await tauriMediaService.preparePlayback(selected),
      fileName: fileNameFromPath(selected),
      probe,
    }
  },

  async closeMedia(playbackUrl: string | null): Promise<void> {
    if (playbackUrl?.startsWith("http://127.0.0.1:")) {
      await invoke("unregister_playback_media", { playbackUrl })
    }
  },

  async probeMedia(inputPath: string): Promise<MediaProbe> {
    return invoke<MediaProbe>("probe_media", { inputPath })
  },

  async preparePlayback(inputPath: string): Promise<string> {
    const registration = await invoke<PlaybackRegistration>("register_playback_media", { inputPath })
    return registration.streamUrl
  },

  async createVideoCacheId(inputPath: string): Promise<string> {
    return invoke<string>("create_video_cache_id", { inputPath })
  },

  async generateTimelineThumbnailRange(request: ThumbnailRequest): Promise<ThumbnailResult> {
    const result = await invoke<ThumbnailResult>("generate_timeline_thumbnail_range", { request })
    return {
      ...result,
      thumbnails: result.thumbnails.map((thumbnail) => ({
        ...thumbnail,
        path: convertFileSrc(thumbnail.path),
      })),
    }
  },

  async generateAudioWaveform(request: AudioWaveformRequest): Promise<AudioWaveformResult> {
    return invoke<AudioWaveformResult>("generate_audio_waveform", { request, cacheOnly: request.cacheOnly ?? false })
  },

  async generatePlaybackProxy(inputPath: string, videoId: string, forceCpu = false): Promise<string> {
    return invoke<string>("generate_playback_proxy", { inputPath, videoId, forceCpu })
  },

  async cancelBackgroundMedia(includeProxy = false): Promise<void> {
    await invoke("cancel_background_media", { includeProxy })
  },
  async cancelTimelineThumbnails(): Promise<void> {
    await invoke("cancel_timeline_thumbnails")
  },

  async setMediaPlaybackState(playing: boolean): Promise<void> {
    await invoke("set_media_playback_state", { playing })
  },

  async getHardwareProfile(): Promise<HardwareProfile> {
    return invoke<HardwareProfile>("get_hardware_profile")
  },

  async getRuntimePerformanceConfig(): Promise<RuntimePerformanceConfig> {
    return invoke<RuntimePerformanceConfig>("get_runtime_performance_config")
  },

  async setPerformancePreset(preset: PerformancePreset): Promise<void> {
    await invoke("set_performance_preset", { preset })
  },

  async updateRuntimeMetrics(metrics: RuntimeMetrics): Promise<RuntimePerformanceConfig> {
    return invoke<RuntimePerformanceConfig>("update_runtime_metrics", { metrics, uiLongTaskRatio: metrics.uiLongTaskRatio ?? null })
  },

  async getMediaTaskBudget(kind: MediaTaskKind): Promise<TaskBudget> {
    return invoke<TaskBudget>("get_media_task_budget", { kind })
  },

  async exportTrim(
    request: ExportTrimRequest,
    onProgress?: ExportProgressHandler,
  ): Promise<{ operationId: string; outputPath: string }> {
    const outputPath =
      request.outputPath ||
      (await save({
          title: request.timeline ? "Экспорт монтажа" : "Export Clips",
        defaultPath: `export.${exportExtensions[request.settings.format]}`,
        filters: [
          {
            name: `${request.settings.format.toUpperCase()} Video`,
            extensions: [exportExtensions[request.settings.format]],
          },
        ],
      }))

    if (!outputPath) {
      return { operationId: "", outputPath: "" }
    }

    const operationId = crypto.randomUUID()
    let unlisten: (() => void) | undefined
    let finished = false

    if (onProgress) {
      unlisten = await listen<ExportProgressEvent>("export-progress", (event) => {
          if (finished || event.payload.operationId !== operationId) return
          onProgress(event.payload)
          if (
            event.payload.status === "completed" ||
            event.payload.status === "failed" ||
            event.payload.status === "cancelled"
          ) {
            finished = true
            unlisten?.()
          }
        })
    }

    try {
      return await invoke<ExportStarted>("export_trim", {
        request: {
          ...request,
          operationId,
          outputPath,
        },
      })
    } catch (error) {
      unlisten?.()
      throw error
    }
  },

  async cancelOperation(operationId: string): Promise<void> {
    if (!operationId) return
    await invoke("cancel_export", { operationId })
  },
}
