import type { AppError } from "@/types/app-error"
import type { ExportProgressEvent, ExportTrimRequest } from "@/types/export"
import type {
  AudioWaveformRequest,
  AudioWaveformResult,
  MediaProbe,
  OpenMediaResult,
  ThumbnailRequest,
  ThumbnailResult,
  TimelineThumbnail,
} from "@/types/media"

export type MediaServiceResult<T> = Promise<T>

export type ExportProgressHandler = (event: ExportProgressEvent) => void

export type MediaService = {
  openMedia: () => MediaServiceResult<OpenMediaResult | null>
  closeMedia: (playbackUrl: string | null) => MediaServiceResult<void>
  probeMedia: (inputPath: string) => MediaServiceResult<MediaProbe>
  preparePlayback: (inputPath: string) => MediaServiceResult<string>
  createVideoCacheId: (inputPath: string) => MediaServiceResult<string>
  generateTimelineThumbnails: (
    inputPath: string,
    duration: number,
  ) => MediaServiceResult<TimelineThumbnail[]>
  generateTimelineThumbnailRange: (request: ThumbnailRequest) => MediaServiceResult<ThumbnailResult>
  generateAudioWaveform: (request: AudioWaveformRequest) => MediaServiceResult<AudioWaveformResult>
  exportTrim: (
    request: ExportTrimRequest,
    onProgress?: ExportProgressHandler,
  ) => MediaServiceResult<{ operationId: string; outputPath: string }>
  cancelOperation: (operationId: string) => MediaServiceResult<void>
}

export function toMediaServiceError(error: unknown): AppError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = error as Partial<AppError>
    return {
      code: candidate.code ?? "UNKNOWN_ERROR",
      title: candidate.title ?? "Operation failed",
      message: candidate.message ?? "The media operation could not be completed.",
      technicalDetails: candidate.technicalDetails,
      recoverable: candidate.recoverable ?? true,
    }
  }

  return {
    code: "UNKNOWN_ERROR",
    title: "Operation failed",
    message: "The media operation could not be completed.",
    technicalDetails: error instanceof Error ? error.message : String(error),
    recoverable: true,
  }
}
