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
  TimelineThumbnail,
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

function preparePlaybackUrl(inputPath: string) {
  return convertFileSrc(inputPath)
}

type TimelineThumbnailResponse = {
  time: number
  path: string
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
      playbackUrl: preparePlaybackUrl(selected),
      fileName: fileNameFromPath(selected),
      probe: await tauriMediaService.probeMedia(selected),
    }
  },

  async closeMedia(): Promise<void> {
    return undefined
  },

  async probeMedia(inputPath: string): Promise<MediaProbe> {
    return invoke<MediaProbe>("probe_media", { inputPath })
  },

  async preparePlayback(inputPath: string): Promise<string> {
    return preparePlaybackUrl(inputPath)
  },

  async createVideoCacheId(inputPath: string): Promise<string> {
    return invoke<string>("create_video_cache_id", { inputPath })
  },

  async generateTimelineThumbnails(
    inputPath: string,
    duration: number,
  ): Promise<TimelineThumbnail[]> {
    const thumbnails = await invoke<TimelineThumbnailResponse[]>("generate_timeline_thumbnails", {
      inputPath,
      duration,
      maxFrames: 72,
    })

    return thumbnails.map((thumbnail) => ({
      time: thumbnail.time,
      url: convertFileSrc(thumbnail.path),
    }))
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
