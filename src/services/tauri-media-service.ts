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
} from "@/types/media"

const videoExtensions = ["mp4", "mov", "mkv", "webm", "avi", "m4v"]
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
  async openMedia(): Promise<OpenMediaResult | null> {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Open Video",
      filters: [{ name: "Video", extensions: videoExtensions }],
    })

    if (typeof selected !== "string") return null

    return {
      originalPath: selected,
      playbackUrl: await tauriMediaService.preparePlayback(selected),
      fileName: fileNameFromPath(selected),
      probe: await tauriMediaService.probeMedia(selected),
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
    return invoke<AudioWaveformResult>("generate_audio_waveform", { request })
  },

  async generatePlaybackProxy(inputPath: string, videoId: string): Promise<string> {
    return invoke<string>("generate_playback_proxy", { inputPath, videoId })
  },

  async cancelBackgroundMedia(): Promise<void> {
    await invoke("cancel_background_media")
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
    return invoke<RuntimePerformanceConfig>("update_runtime_metrics", { metrics })
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
        title: "Export Clips",
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

    let unlisten: (() => void) | undefined

    if (onProgress) {
      unlisten = await listen<ExportProgressEvent>("export-progress", (event) => {
          onProgress(event.payload)
          if (
            event.payload.status === "completed" ||
            event.payload.status === "failed" ||
            event.payload.status === "cancelled"
          ) {
            unlisten?.()
          }
        })
    }

    try {
      return await invoke<ExportStarted>("export_trim", {
        request: {
          ...request,
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
