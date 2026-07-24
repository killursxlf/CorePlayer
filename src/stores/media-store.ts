import { create } from "zustand"
import type { AppError } from "@/types/app-error"
import type { ExportStatus, MediaState, OpenMediaResult } from "@/types/media"

type MediaStoreActions = {
  loadMedia: (media: OpenMediaResult) => void
  closeMedia: () => void
  setCurrentTime: (currentTime: number) => void
  setDuration: (duration: number) => void
  setVolume: (volume: number) => void
  setPlaybackRate: (playbackRate: number) => void
  setPlaying: (isPlaying: boolean) => void
  setLoading: (isLoading: boolean) => void
  setTrimStart: (trimStart: number) => void
  setTrimEnd: (trimEnd: number | null) => void
  setExportProgress: (exportProgress: number) => void
  setExportStatus: (exportStatus: ExportStatus) => void
  setError: (error: AppError | null) => void
  resetExport: () => void
}

export type MediaStore = MediaState & MediaStoreActions

export const initialMediaState: MediaState = {
  originalPath: null,
  playbackUrl: null,
  fileName: null,

  duration: 0,
  currentTime: 0,
  volume: 1,
  playbackRate: 1,

  isPlaying: false,
  isLoading: false,

  trimStart: 0,
  trimEnd: null,

  exportProgress: 0,
  exportStatus: "idle",

  error: null,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export const useMediaStore = create<MediaStore>((set, get) => ({
  ...initialMediaState,

  loadMedia: (media) =>
    set({
      originalPath: media.originalPath,
      playbackUrl: media.playbackUrl,
      fileName: media.fileName,
      duration: media.probe.duration,
      currentTime: 0,
      isPlaying: false,
      isLoading: false,
      trimStart: 0,
      trimEnd: media.probe.duration,
      exportProgress: 0,
      exportStatus: "idle",
      error: null,
    }),

  closeMedia: () => set(initialMediaState),

  setCurrentTime: (currentTime) => {
    const { duration } = get()
    set({ currentTime: duration > 0 ? clamp(currentTime, 0, duration) : Math.max(0, currentTime) })
  },

  setDuration: (duration) =>
    set((state) => {
      const safeDuration = Math.max(0, duration)
      return {
        duration: safeDuration,
        currentTime: clamp(state.currentTime, 0, safeDuration),
        trimStart: clamp(state.trimStart, 0, safeDuration),
        trimEnd: state.trimEnd == null || state.trimEnd <= 0 ? safeDuration : clamp(state.trimEnd, 0, safeDuration),
      }
    }),

  setVolume: (volume) => set({ volume: clamp(volume, 0, 1) }),
  setPlaybackRate: (playbackRate) => set({ playbackRate: clamp(playbackRate, 0.25, 4) }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setLoading: (isLoading) => set({ isLoading }),

  setTrimStart: (trimStart) =>
    set((state) => {
      const end = state.trimEnd ?? state.duration
      return { trimStart: clamp(trimStart, 0, Math.max(0, end - 0.001)) }
    }),

  setTrimEnd: (trimEnd) =>
    set((state) => {
      if (trimEnd == null) return { trimEnd: null }
      return { trimEnd: clamp(trimEnd, state.trimStart + 0.001, state.duration) }
    }),

  setExportProgress: (exportProgress) => set({ exportProgress: clamp(exportProgress, 0, 1) }),
  setExportStatus: (exportStatus) => set({ exportStatus }),
  setError: (error) => set({ error }),
  resetExport: () => set({ exportProgress: 0, exportStatus: "idle" }),
}))
