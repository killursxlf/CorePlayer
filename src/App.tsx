"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePlaybackProxy } from "@/hooks/use-playback-proxy"
import { clipAt, deleteRanges, editDuration, moveClips, moveRanges, sourceStart, splitClip, trimClip, type TimeRange, type TimelineContent } from "@/lib/timeline-edit"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { LoaderCircle, PanelRightOpen } from "lucide-react"
import { MenuBar } from "@/components/editor/menu-bar"
import { Toolbar } from "@/components/editor/toolbar"
import { ToolSidebar } from "@/components/editor/tool-sidebar"
import { Preview } from "@/components/editor/preview"
import { Inspector } from "@/components/editor/inspector"
import { Timeline } from "@/components/editor/timeline"
import { StatusBar } from "@/components/editor/status-bar"
import { ExportSettingsPanel } from "@/components/editor/export-settings-panel"
import { ExportProgressPanel, type ExportFeedback } from "@/components/editor/export-progress-panel"
import { ErrorNotice } from "@/components/feedback/error-notice"
import { getMediaService } from "@/services/media-service-provider"
import { toMediaServiceError } from "@/services/media-service"
import {
  chooseProjectToOpen,
  chooseProjectToSave,
  readProject,
  writeProject,
  type ProjectFile,
} from "@/services/project-service"
import { useMediaStore } from "@/stores/media-store"
import { usePerformanceStore } from "@/stores/performance-store"
import { playbackClock } from "@/stores/playback-clock"
import { createAppError } from "@/types/app-error"
import { isValidTrimRange } from "@/utils/time"
import type { Annotation, TimelineClip, TimelineMarker, ToolId, VideoInfo } from "@/lib/editor-types"
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/export-settings"
import type { ExportSettings } from "@/types/export"
import type { OpenMediaResult, RuntimeMetrics, SeekMode } from "@/types/media"

const EMPTY_VIDEO_INFO: VideoInfo = {
  filename: "No media selected",
  duration: 0,
  codec: "Unknown",
  resolution: "Unknown",
  fps: 30,
  fpsKnown: false,
  bitrate: "Unknown",
  audioStreams: "None",
  subtitles: "None",
}

const INITIAL_ANNOTATIONS: Annotation[] = []

const INITIAL_MARKERS: TimelineMarker[] = []
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const

type ProjectSnapshot = {
  selectedRange: TimeRange | null
  playhead: number
  annotations: Annotation[]
  markers: TimelineMarker[]
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  selectedId: string | null
  trimStart: number
  trimEnd: number | null
}

function cloneAnnotations(annotations: Annotation[]) {
  return structuredClone(annotations)
}

function cloneMarkers(markers: TimelineMarker[]) {
  return markers.map((marker) => ({ ...marker }))
}

function cloneClips(clips: TimelineClip[]) {
  return clips.map((clip) => ({ ...clip }))
}

function numberClipLabels(clips: TimelineClip[]) {
  return clips.map((clip, index) => ({ ...clip, label: `Clip ${index + 1}` }))
}

function normalizeFps(fps: number | undefined) {
  return Number.isFinite(fps) && fps && fps > 0 ? fps : 30
}

function isKnownFps(fps: number | undefined) {
  return Boolean(Number.isFinite(fps) && fps && fps > 0)
}

function normalizeInfoText(value: string | undefined, fallback = "Unknown") {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

function benefitsFromPlaybackProxy(codecName: string, resolutionText: string, bitrateText: string) {
  const codec = codecName.toLowerCase()
  const resolution = resolutionText.match(/(\d+)\s*x\s*(\d+)/i)
  const width = Number(resolution?.[1] ?? 0)
  const height = Number(resolution?.[2] ?? 0)
  const bitrateValue = Number.parseFloat(bitrateText.replace(",", "."))
  const bitrateMbps = /gbps/i.test(bitrateText)
    ? bitrateValue * 1000
    : /kbps/i.test(bitrateText)
      ? bitrateValue / 1000
      : bitrateValue
  return (
    width >= 3840 ||
    height >= 2160 ||
    codec.includes("hevc") ||
    codec.includes("h.265") ||
    codec.includes("av1") ||
    (Number.isFinite(bitrateMbps) && bitrateMbps >= 35)
  )
}

function isTextEditingTarget(target: HTMLElement | null) {
  const tagName = target?.tagName
  if (!target || target.isContentEditable || tagName === "TEXTAREA" || tagName === "SELECT") {
    return Boolean(target)
  }

  if (tagName !== "INPUT") return false

  const input = target as HTMLInputElement
  const type = input.type.toLowerCase()
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type)
}

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("select")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [saved, setSaved] = useState(true)
  const editRevisionRef = useRef(0)
  const projectVersionRef = useRef(0)
  const projectSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const transitionRef = useRef(false)
  const [discardDialog, setDiscardDialog] = useState(false)
  const discardResolverRef = useRef<((choice: "save" | "discard" | "cancel") => void) | null>(null)
  const gestureRef = useRef<{ snapshot: ProjectSnapshot; recorded: boolean } | null>(null)
  const markUnsaved = useCallback(() => {
    editRevisionRef.current += 1
    setSaved(false)
  }, [])
  const answerDiscard = useCallback((choice: "save" | "discard" | "cancel") => {
    setDiscardDialog(false)
    discardResolverRef.current?.(choice)
    discardResolverRef.current = null
  }, [])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [exportOperationId, setExportOperationId] = useState<string | null>(null)
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null)
  const [mediaDetails, setMediaDetails] = useState<VideoInfo>(EMPTY_VIDEO_INFO)
  const [mediaSession, setMediaSession] = useState(0)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [timelineVisible, setTimelineVisible] = useState(true)
  const [videoCacheId, setVideoCacheId] = useState<string | null>(null)
  const [thumbnailCacheDir, setThumbnailCacheDir] = useState<string | null>(null)
  const [recentMediaPath, setRecentMediaPath] = useState<string | null>(null)
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const [exportScope, setExportScope] = useState<"timeline" | "selected" | "all">("timeline")
  const undoStackRef = useRef<ProjectSnapshot[]>([])
  const redoStackRef = useRef<ProjectSnapshot[]>([])
  const annotationClipboardRef = useRef<Annotation | null>(null)
  const lastPressureRef = useRef<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  const [annotations, setAnnotations] = useState<Annotation[]>(INITIAL_ANNOTATIONS)
  const [markers, setMarkers] = useState<TimelineMarker[]>(INITIAL_MARKERS)
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [selectedRange, setSelectedRange] = useState<TimeRange | null>(null)
  const [rippleDelete, setRippleDelete] = useState(true)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pxPerSecond, setPxPerSecond] = useState(14)
  const [seekRevision, setSeekRevision] = useState(0)
  const [seekTarget, setSeekTarget] = useState(0)
  const [seekMode, setSeekMode] = useState<SeekMode>("precise")
  const [seekFrameTime, setSeekFrameTime] = useState<number | null>(null)
  const previewSeekTimerRef = useRef<number | null>(null)
  const pendingPreviewSeekRef = useRef<number | null>(null)
  const lastPreviewSeekAtRef = useRef(0)

  const originalPath = useMediaStore((state) => state.originalPath)
  const playbackUrl = useMediaStore((state) => state.playbackUrl)
  const fileName = useMediaStore((state) => state.fileName)
  const duration = useMediaStore((state) => state.duration)
  const currentTime = useMediaStore((state) => state.currentTime)
  const volume = useMediaStore((state) => state.volume)
  const playbackRate = useMediaStore((state) => state.playbackRate)
  const isPlaying = useMediaStore((state) => state.isPlaying)
  const isLoading = useMediaStore((state) => state.isLoading)
  const exportProgress = useMediaStore((state) => state.exportProgress)
  const exportStatus = useMediaStore((state) => state.exportStatus)
  const error = useMediaStore((state) => state.error)
  const trimStart = useMediaStore((state) => state.trimStart)
  const trimEnd = useMediaStore((state) => state.trimEnd)
  const loadMedia = useMediaStore((state) => state.loadMedia)
  const closeMedia = useMediaStore((state) => state.closeMedia)
  const setCurrentTime = useMediaStore((state) => state.setCurrentTime)
  const setPlaybackUrl = useMediaStore((state) => state.setPlaybackUrl)
  const setDuration = useMediaStore((state) => state.setDuration)
  const setVolume = useMediaStore((state) => state.setVolume)
  const setPlaybackRate = useMediaStore((state) => state.setPlaybackRate)
  const setPlaying = useMediaStore((state) => state.setPlaying)
  const setLoading = useMediaStore((state) => state.setLoading)
  const setTrimStart = useMediaStore((state) => state.setTrimStart)
  const setTrimEnd = useMediaStore((state) => state.setTrimEnd)
  const setExportProgress = useMediaStore((state) => state.setExportProgress)
  const setExportStatus = useMediaStore((state) => state.setExportStatus)
  const setError = useMediaStore((state) => state.setError)
  const setPerformanceConfig = usePerformanceStore((state) => state.setConfig)
  const performanceConfig = usePerformanceStore((state) => state.config)

  const mediaService = getMediaService()
  const hasMedia = Boolean(originalPath && playbackUrl)
  const effectiveDuration = hasMedia ? editDuration(clips) : 0
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null
  const trim: [number, number] = selectedClip
    ? [selectedClip.startTime, selectedClip.endTime]
    : [trimStart, trimEnd ?? effectiveDuration]
  const videoInfo: VideoInfo = {
    ...mediaDetails,
    filename: fileName ?? EMPTY_VIDEO_INFO.filename,
    duration: effectiveDuration,
  }

  useEffect(() => {
    void mediaService.setMediaPlaybackState(isPlaying).catch(() => undefined)
  }, [isPlaying, mediaService])

  useEffect(() => {
    void mediaService
      .getRuntimePerformanceConfig()
      .then((config) => {
        setPerformanceConfig(config)
        if (import.meta.env.DEV) console.info("[media-resources:init]", config)
      })
      .catch(() => undefined)
  }, [mediaService, setPerformanceConfig])

  const handlePerformanceMetrics = useCallback(
    (metrics: RuntimeMetrics) => {
      void mediaService
        .updateRuntimeMetrics(metrics)
        .then((config) => {
          setPerformanceConfig(config)
          if (import.meta.env.DEV && lastPressureRef.current !== config.pressure) {
            lastPressureRef.current = config.pressure
            console.info("[media-resources:pressure]", config)
          }
        })
        .catch(() => undefined)
    },
    [mediaService, setPerformanceConfig],
  )

  const switchPlaybackCopy = useCallback((url: string) => {
    const resumeAt = playbackClock.getSnapshot()
    setPlaybackUrl(url)
    setCurrentTime(resumeAt)
    setSeekTarget(resumeAt)
    setSeekMode("precise")
    setSeekRevision(revision => revision + 1)
  }, [setCurrentTime, setPlaybackUrl])
  const playbackCopy = usePlaybackProxy(mediaService, originalPath, videoCacheId, mediaSession,
    videoInfo.hasVideo !== false && benefitsFromPlaybackProxy(videoInfo.codec, videoInfo.resolution, videoInfo.bitrate)
      && (performanceConfig?.hardware.hardwareDecodeAvailable === false || (performanceConfig?.droppedFrameRatio ?? 0) >= 0.03),
    isPlaying, switchPlaybackCopy)

  const fileNameFromPath = useCallback((path: string) => path.split(/[\\/]/).pop() || path, [])

  const synchronizePlaybackTime = useCallback(
    (time: number) => {
      playbackClock.set(time)
      setCurrentTime(time)
    },
    [setCurrentTime],
  )

  const handleUserSeek = useCallback(
    (time: number, mode: SeekMode = "precise", frameTime?: number) => {
      synchronizePlaybackTime(frameTime ?? time)
      setSeekFrameTime(mode === "frame" ? frameTime ?? null : null)
      if (mode !== "preview") {
        setSeekTarget(time)
        pendingPreviewSeekRef.current = null
        if (previewSeekTimerRef.current != null) {
          window.clearTimeout(previewSeekTimerRef.current)
          previewSeekTimerRef.current = null
        }
        setSeekMode(mode)
        setSeekRevision((revision) => revision + 1)
        return
      }

      pendingPreviewSeekRef.current = time
      if (previewSeekTimerRef.current != null) return
      const delay = Math.max(0, 60 - (performance.now() - lastPreviewSeekAtRef.current))
      previewSeekTimerRef.current = window.setTimeout(() => {
        previewSeekTimerRef.current = null
        if (pendingPreviewSeekRef.current == null) return
        setSeekTarget(pendingPreviewSeekRef.current)
        pendingPreviewSeekRef.current = null
        lastPreviewSeekAtRef.current = performance.now()
        setSeekMode("preview")
        setSeekRevision((revision) => revision + 1)
      }, delay)
    },
    [synchronizePlaybackTime],
  )

  useEffect(
    () => () => {
      if (previewSeekTimerRef.current != null) {
        window.clearTimeout(previewSeekTimerRef.current)
      }
    },
    [],
  )

  const createSnapshot = useCallback(
    (): ProjectSnapshot => ({
      selectedRange,
      playhead: playbackClock.getSnapshot(),
      annotations: cloneAnnotations(annotations),
      markers: cloneMarkers(markers),
      clips: cloneClips(clips),
      selectedClipId,
      selectedClipIds: [...selectedClipIds],
      selectedId,
      trimStart,
      trimEnd,
    }),
    [annotations, clips, markers, selectedClipId, selectedClipIds, selectedId, selectedRange, trimEnd, trimStart],
  )

  const applySnapshot = useCallback(
    (snapshot: ProjectSnapshot) => {
      setAnnotations(cloneAnnotations(snapshot.annotations))
      setMarkers(cloneMarkers(snapshot.markers))
      setClips(cloneClips(snapshot.clips))
      setSelectedRange(snapshot.selectedRange)
      setPlaying(false)
      handleUserSeek(snapshot.playhead, "precise")
      setSelectedClipId(snapshot.selectedClipId)
      setSelectedClipIds([...snapshot.selectedClipIds])
      setSelectedId(snapshot.selectedId)
      setTrimStart(snapshot.trimStart)
      setTrimEnd(snapshot.trimEnd)
      markUnsaved()
    },
    [markUnsaved, setTrimEnd, setTrimStart, handleUserSeek, setPlaying],
  )

  const beginEdit = useCallback(() => {
    if (!gestureRef.current) gestureRef.current = { snapshot: createSnapshot(), recorded: false }
  }, [createSnapshot])
  const endEdit = useCallback(() => { gestureRef.current = null }, [])
  useEffect(() => {
    const end = () => queueMicrotask(endEdit)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    window.addEventListener("blur", end)
    return () => {
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      window.removeEventListener("blur", end)
    }
  }, [endEdit])

  const pushHistory = useCallback(() => {
    const gesture = gestureRef.current
    if (gesture?.recorded) return
    undoStackRef.current = [...undoStackRef.current.slice(-99), gesture?.snapshot ?? createSnapshot()]
    if (gesture) gesture.recorded = true
    redoStackRef.current = []
    setHistoryVersion((version) => version + 1)
  }, [createSnapshot])

  const selectClip = useCallback((clipId: string, additive = false) => {
    setSelectedRange(null)
    setSelectedId(null)
    setSelectedClipIds((prev) => {
      if (!additive) {
        setSelectedClipId(clipId)
        return [clipId]
      }
      if (prev.includes(clipId)) {
        const next = prev.filter((id) => id !== clipId)
        const selection = next
        setSelectedClipId(selection[selection.length - 1] ?? null)
        return selection
      }
      setSelectedClipId(clipId)
      return [...prev, clipId]
    })
  }, [])

  const undo = useCallback(() => {
    endEdit()
    const snapshot = undoStackRef.current.pop()
    if (!snapshot) return

    redoStackRef.current = [...redoStackRef.current.slice(-99), createSnapshot()]
    applySnapshot(snapshot)
    setHistoryVersion((version) => version + 1)
  }, [applySnapshot, createSnapshot, endEdit])

  const redo = useCallback(() => {
    endEdit()
    const snapshot = redoStackRef.current.pop()
    if (!snapshot) return

    undoStackRef.current = [...undoStackRef.current.slice(-99), createSnapshot()]
    applySnapshot(snapshot)
    setHistoryVersion((version) => version + 1)
  }, [applySnapshot, createSnapshot, endEdit])

  const applyMedia = useCallback(
    (media: OpenMediaResult, project?: ProjectFile, cacheId?: string) => {
      projectVersionRef.current += 1
      setSeekTarget(0)
      setSeekRevision(value => value + 1)
      setSeekMode("precise")
      setVideoCacheId(cacheId ?? null)
      setThumbnailCacheDir(null)
      endEdit()
      loadMedia(media)
      setMediaSession(session => session + 1)
      playbackClock.set(0)
      setMediaDetails({
        ...EMPTY_VIDEO_INFO,
        filename: media.fileName,
        hasVideo: media.probe.hasVideo,
        variableFps: media.probe.variableFps,
        duration: media.probe.duration,
        codec: normalizeInfoText(media.probe.codec),
        resolution: normalizeInfoText(media.probe.resolution),
        fps: normalizeFps(media.probe.fps),
        fpsKnown: isKnownFps(media.probe.fps),
        bitrate: normalizeInfoText(media.probe.bitrate),
        audioStreams: normalizeInfoText(media.probe.audioStreams, "None"),
        subtitles: normalizeInfoText(media.probe.subtitles, "None"),
      })
      setRecentMediaPath(media.originalPath)
      const initialClip: TimelineClip = {
        id: `clip-${Date.now()}`,
        label: "Clip 1",
        startTime: 0,
        endTime: media.probe.duration,
      }
      const restoredClips = project ? numberClipLabels(project.clips) : [initialClip]
      setSelectedRange(null)
      const selectedClipIds = project?.selectedClipIds?.filter((id) =>
        restoredClips.some((clip) => clip.id === id),
      )
      const selectedClipId =
        (project?.selectedClipId && restoredClips.some((clip) => clip.id === project.selectedClipId)
          ? project.selectedClipId
          : selectedClipIds?.[selectedClipIds.length - 1]) ?? restoredClips[0]?.id ?? null

      setAnnotations(project ? cloneAnnotations(project.annotations) : [])
      setMarkers(project ? cloneMarkers(project.markers) : [])
      setClips(restoredClips)
      setSelectedClipId(selectedClipId)
      setSelectedClipIds(selectedClipIds?.length ? selectedClipIds : selectedClipId ? [selectedClipId] : [])
      setSelectedId(project?.selectedAnnotationId ?? null)
      if (project) {
        setExportSettings(project.exportSettings ?? DEFAULT_EXPORT_SETTINGS)
        setExportScope(project.exportScope)
        setVolume(project.volume)
        setPlaybackRate(project.playbackRate)
      }
      undoStackRef.current = []
      redoStackRef.current = []
      annotationClipboardRef.current = null
      setHistoryVersion((version) => version + 1)
      setSaved(true)

    },
    [endEdit, loadMedia, setPlaybackRate, setVolume],
  )

  const addMarker = useCallback(() => {
    if (!hasMedia) return
    pushHistory()
    setMarkers((prev) => [
      ...prev,
      {
        id: `m${Date.now()}`,
        time: currentTime,
        label: "Marker",
        color: "#3b82f6",
      },
    ])
    markUnsaved()
  }, [currentTime, hasMedia, markUnsaved, pushHistory])

  const createProjectFile = useCallback(
    (): ProjectFile | null => {
      if (!originalPath) return null
      return {
        version: 2,
        mediaPath: originalPath,
        annotations: cloneAnnotations(annotations),
        markers: cloneMarkers(markers),
        clips: cloneClips(clips),
        selectedClipId,
        selectedClipIds: [...selectedClipIds],
        selectedAnnotationId: selectedId,
        exportSettings,
        exportScope,
        volume,
        playbackRate,
      }
    },
    [
      annotations,
      clips,
      exportScope,
      exportSettings,
      markers,
      originalPath,
      playbackRate,
      selectedClipId,
      selectedClipIds,
      selectedId,
      volume,
    ],
  )

  const saveProjectToPath = useCallback(
    async (path: string) => {
      const project = createProjectFile()
      if (!project) return
      const revision = editRevisionRef.current
      const version = projectVersionRef.current
      const writing = projectSaveQueueRef.current.catch(() => undefined).then(() => writeProject(path, project))
      projectSaveQueueRef.current = writing
      await writing
      if (version !== projectVersionRef.current) return false
      setProjectPath(path)
      if (revision === editRevisionRef.current) setSaved(true)
      return revision === editRevisionRef.current
    },
    [createProjectFile],
  )

  const handleSaveAs = useCallback(async () => {
    if (!hasMedia) return
    setError(null)
    try {
      const fallbackName = `${(fileName ?? "project").replace(/\.[^/.]+$/, "")}.lumen.json`
      const path = await chooseProjectToSave(fallbackName)
      return path ? Boolean(await saveProjectToPath(path)) : false
    } catch (error) {
      setError(
        createAppError({
          code: "PROJECT_SAVE_FAILED",
          title: "Project was not saved",
          message: "The project file could not be written.",
          technicalDetails: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
      )
    }
  }, [fileName, hasMedia, saveProjectToPath, setError])

  const handleSave = useCallback(async () => {
    if (!hasMedia) return
    if (!projectPath) {
      return handleSaveAs()
    }
    setError(null)
    try {
      return await saveProjectToPath(projectPath)
    } catch (error) {
      setError(
        createAppError({
          code: "PROJECT_SAVE_FAILED",
          title: "Project was not saved",
          message: "The project file could not be written.",
          technicalDetails: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
      )
    }
  }, [handleSaveAs, hasMedia, projectPath, saveProjectToPath, setError])

  const allowProjectChange = useCallback(async () => {
    const state = useMediaStore.getState()
    if (state.exportStatus === "preparing" || state.exportStatus === "exporting") {
      setError(createAppError({code: "EXPORT_ACTIVE", title: "Export in progress", message: "Finish or cancel the export before replacing this project.", recoverable: true}))
      return false
    }
    if (saved || !state.originalPath) return true
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
      discardResolverRef.current = resolve
      setDiscardDialog(true)
    })
    return choice === "discard" || (choice === "save" && Boolean(await handleSave()))
  }, [handleSave, saved, setError])

  const openMediaTransaction = useCallback(async (choose: () => Promise<{media: OpenMediaResult; project?: ProjectFile; path?: string} | null>) => {
    if (transitionRef.current) return
    transitionRef.current = true
    let prepared: OpenMediaResult | null = null
    try {
      if (!await allowProjectChange()) return
      setLoading(true)
      setError(null)
      const result = await choose()
      if (!result) return
      prepared = result.media
      const cacheId = await mediaService.createVideoCacheId(prepared.originalPath)
      const previousUrl = useMediaStore.getState().playbackUrl
      await mediaService.cancelBackgroundMedia(true)
      applyMedia(prepared, result.project, cacheId)
      prepared = null
      setProjectPath(result.path ?? null)
      if (previousUrl) await mediaService.closeMedia(previousUrl).catch(() => undefined)
    } catch (error) {
      setError(toMediaServiceError(error))
    } finally {
      if (prepared) await mediaService.closeMedia(prepared.playbackUrl).catch(() => undefined)
      transitionRef.current = false
      setLoading(false)
    }
  }, [allowProjectChange, applyMedia, mediaService, setError, setLoading])

  const handleOpenVideo = useCallback(() => openMediaTransaction(async () => {
    const media = await mediaService.openMedia()
    return media ? {media} : null
  }), [mediaService, openMediaTransaction])

  const handleOpenRecent = useCallback(() => openMediaTransaction(async () => {
    if (!recentMediaPath) return null
    const probe = await mediaService.probeMedia(recentMediaPath)
    return {media: {originalPath: recentMediaPath, fileName: fileNameFromPath(recentMediaPath), probe,
      playbackUrl: await mediaService.preparePlayback(recentMediaPath)}}
  }), [fileNameFromPath, mediaService, openMediaTransaction, recentMediaPath])

  const handleOpenProject = useCallback(() => openMediaTransaction(async () => {
    const path = await chooseProjectToOpen()
    if (!path) return null
    const project = await readProject(path)
    const probe = await mediaService.probeMedia(project.mediaPath)
    if (project.clips.some(clip => sourceStart(clip) + clip.endTime - clip.startTime > probe.duration + 0.05)) throw new Error("A project clip extends beyond the source duration.")
    return {path, project, media: {originalPath: project.mediaPath, fileName: fileNameFromPath(project.mediaPath), probe,
      playbackUrl: await mediaService.preparePlayback(project.mediaPath)}}
  }), [fileNameFromPath, mediaService, openMediaTransaction])

  const handleNewProject = useCallback(async () => {
    if (transitionRef.current) return
    transitionRef.current = true
    try {
      if (!await allowProjectChange()) return
      const previousUrl = useMediaStore.getState().playbackUrl
      await mediaService.cancelBackgroundMedia(true)
      closeMedia()
      projectVersionRef.current += 1
      playbackClock.set(0)
      endEdit()
      setMediaDetails(EMPTY_VIDEO_INFO)
      setVideoCacheId(null)
      setThumbnailCacheDir(null)
      setAnnotations([])
      setMarkers([])
      setClips([])
      setSelectedRange(null)
      setSelectedClipId(null)
      setSelectedClipIds([])
      setSelectedId(null)
      setPxPerSecond(14)
      setZoom(100)
      setProjectPath(null)
      setExportSettings(DEFAULT_EXPORT_SETTINGS)
      setExportScope("timeline")
      undoStackRef.current = []
      redoStackRef.current = []
      annotationClipboardRef.current = null
      setHistoryVersion(version => version + 1)
      setSaved(true)
      setError(null)
      if (previousUrl) await mediaService.closeMedia(previousUrl).catch(() => undefined)
    } catch (error) { setError(toMediaServiceError(error)) }
    finally { transitionRef.current = false }
  }, [allowProjectChange, closeMedia, endEdit, mediaService, setError])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!saved || useMediaStore.getState().exportStatus === "exporting") { event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [saved])
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault()
      if (transitionRef.current) return
      transitionRef.current = true
      try {
        if (await allowProjectChange()) {
          await mediaService.cancelBackgroundMedia(true)
          await getCurrentWindow().destroy()
        }
      } catch (error) { setError(toMediaServiceError(error)) }
      finally { transitionRef.current = false }
    }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(() => undefined)
    return () => { disposed = true; unlisten?.() }
  }, [allowProjectChange, mediaService, setError])

  const fitZoomToScreen = useCallback(() => {
    setZoom(100)
  }, [])

  const handleLoadedMetadata = useCallback(
    (metadata: { duration: number; resolution: string }) => {
      if (duration <= 0) setDuration(metadata.duration)
      setMediaDetails((details) => ({
        ...details,
        duration: duration > 0 ? duration : metadata.duration,
        resolution: details.resolution === "Unknown" ? metadata.resolution : details.resolution,
      }))
    },
    [duration, setDuration],
  )

  const selected = annotations.find((a) => a.id === selectedId) ?? null

  const updateSelected = useCallback(
    (patch: Partial<Annotation>) => {
      if (!selectedId) return
      pushHistory()
      setAnnotations((prev) => prev.map((a) => (a.id === selectedId ? { ...a, ...patch } : a)))
      markUnsaved()
    },
    [markUnsaved, pushHistory, selectedId],
  )

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    pushHistory()
    setAnnotations((prev) => prev.filter((a) => a.id !== selectedId))
    setSelectedId(null)
    markUnsaved()
  }, [markUnsaved, pushHistory, selectedId])

  const copySelected = useCallback(() => {
    const selected = annotations.find((annotation) => annotation.id === selectedId)
    if (!selected) return
    annotationClipboardRef.current = { ...selected }
    setHistoryVersion((version) => version + 1)
  }, [annotations, selectedId])

  const cutSelected = useCallback(() => {
    const selected = annotations.find((annotation) => annotation.id === selectedId)
    if (!selected) return
    annotationClipboardRef.current = { ...selected }
    deleteSelected()
    setHistoryVersion((version) => version + 1)
  }, [annotations, deleteSelected, selectedId])

  const pasteAnnotation = useCallback(() => {
    const source = annotationClipboardRef.current
    if (!source || !hasMedia) return

    pushHistory()
    const span = Math.max(source.endTime - source.startTime, 1)
    const startTime = Math.min(currentTime, Math.max(0, effectiveDuration - span))
    const endTime = Math.min(effectiveDuration, startTime + span)
    const pasted: Annotation = {
      ...source,
      id: `a${Date.now()}`,
      label: `${source.label} Copy`,
      startTime,
      endTime,
      x: Math.min(1 - source.width, source.x + 0.03),
      y: Math.min(1 - source.height, source.y + 0.03),
    }
    setAnnotations((prev) => [...prev, pasted])
    setSelectedId(pasted.id)
    markUnsaved()
  }, [currentTime, effectiveDuration, hasMedia, markUnsaved, pushHistory])

  const createAnnotation = useCallback(
    (annotation: Annotation) => {
      if (!hasMedia) return
      pushHistory()
      setAnnotations((prev) => [...prev, annotation])
      setSelectedId(annotation.id)
      markUnsaved()
    },
    [hasMedia, markUnsaved, pushHistory],
  )

  const patchAnnotation = useCallback((id: string, patch: Partial<Annotation>) => {
    pushHistory()
    setAnnotations((prev) => prev.map((annotation) => (annotation.id === id ? { ...annotation, ...patch } : annotation)))
    markUnsaved()
  }, [markUnsaved, pushHistory])

  const commitTimeline = useCallback((content: TimelineContent, ids: string[] = [], cursor = playbackClock.getSnapshot()) => {
    pushHistory()
    setClips(numberClipLabels(content.clips))
    setAnnotations(content.annotations)
    setMarkers(content.markers)
    const selection = ids.filter(id => content.clips.some(clip => clip.id === id))
    setSelectedClipIds(selection)
    setSelectedClipId(selection.at(-1) ?? null)
    setSelectedRange(null)
    setSelectedId(null)
    setPlaying(false)
    handleUserSeek(Math.min(cursor, editDuration(content.clips)), "precise")
    markUnsaved()
  }, [pushHistory, markUnsaved, handleUserSeek, setPlaying])

  const editFrameDuration = 1 / videoInfo.fps
  const handleTrimChange = useCallback((range: TimeRange) => {
    if (!selectedClipId) return
    const next = trimClip(clips, selectedClipId, range, duration, editFrameDuration)
    if (next !== clips) commitTimeline({ clips: next, annotations, markers }, [selectedClipId])
  }, [clips, annotations, markers, selectedClipId, duration, editFrameDuration, commitTimeline])

  const splitSelectedClip = useCallback(() => {
    const time = playbackClock.getSnapshot()
    const next = splitClip(clips, time, editFrameDuration)
    if (next === clips) return
    const selected = clipAt(next, time)
    commitTimeline({ clips: next, annotations, markers }, selected ? [selected.id] : [])
  }, [clips, annotations, markers, editFrameDuration, commitTimeline])

  const deleteSelectedClip = useCallback((closeGap = rippleDelete) => {
    const ranges: TimeRange[] = selectedRange ? [selectedRange]
      : clips.filter(clip => selectedClipIds.includes(clip.id)).map(clip => [clip.startTime, clip.endTime])
    if (!ranges.length) return
    const content = { clips, annotations, markers }
    const next = deleteRanges(content, ranges, closeGap)
    if (next !== content) commitTimeline(next, [], Math.min(...ranges.map(range => range[0])))
  }, [clips, annotations, markers, selectedClipIds, selectedRange, rippleDelete, commitTimeline])

  const moveSelectedClips = useCallback((ids: string[], target: number) => {
    const content = { clips, annotations, markers }
    const next = moveClips(content, ids, target)
    if (next !== content) commitTimeline(next, ids, next.clips.find(clip => ids.includes(clip.id))?.startTime ?? target)
  }, [clips, annotations, markers, commitTimeline])

  const selectRange = useCallback((range: TimeRange | null) => {
    setSelectedRange(range)
    setSelectedClipIds([])
    setSelectedClipId(null)
    setSelectedId(null)
  }, [])

  const moveSelectedRange = useCallback((range: TimeRange, target: number) => {
    const content = { clips, annotations, markers }
    const next = moveRanges(content, [range], target)
    if (next === content) return
    const start = target - Math.max(0, Math.min(target, range[1]) - range[0])
    commitTimeline(next, [], start)
    setSelectedRange([start, start + range[1] - range[0]])
  }, [clips, annotations, markers, commitTimeline])

  const selectAllClips = useCallback(() => {
    setSelectedRange(null)
    setSelectedId(null)
    if (clips.length === 0) return
    const ids = clips.map((clip) => clip.id)
    setSelectedClipIds(ids)
    setSelectedClipId(ids[ids.length - 1])
  }, [clips])

  const exportableClips = useCallback(() => {
    const selectedSet = new Set(selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [])
    const sourceClips = exportScope !== "selected" ? clips : clips.filter((clip) => selectedSet.has(clip.id))
    return sourceClips
      .filter((clip) => clip.endTime > clip.startTime)
      .map((clip) => ({
        id: clip.id,
        label: clip.label,
        startTime: clip.startTime,
        endTime: clip.endTime,
        sourceStart: sourceStart(clip),
      }))
  }, [clips, exportScope, selectedClipId, selectedClipIds])

  const toggleAppFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    void document.documentElement.requestFullscreen()
  }, [])

  const handleExport = useCallback(async () => {
    if (transitionRef.current || ["preparing", "exporting"].includes(useMediaStore.getState().exportStatus)) return
    if (!originalPath) {
      setError({
        code: "NO_MEDIA",
        title: "No media selected",
        message: "Open a local video or audio file before exporting a trim range.",
        recoverable: true,
      })
      return
    }

    const clipsToExport = exportableClips()
    if (clipsToExport.length === 0 || !clipsToExport.every((clip) => isValidTrimRange(clip.startTime, clip.endTime))) {
      setError({
        code: "INVALID_TRIM_RANGE",
        title: "Invalid trim range",
        message: "Create at least one valid clip before exporting. Every clip must have Out after In.",
        recoverable: true,
      })
      return
    }

    setError(null)
    setExportProgress(0)
    setExportStatus("preparing")
    const startedAt = Date.now()
    setExportFeedback({ startedAt, updatedAt: startedAt, advancedAt: startedAt, sampleAt: null, sampleProgress: 0, progress: 0, message: "Выберите файл для сохранения. Затем начнётся подготовка кодировщика.", outputPath: "", cancelling: false })
    setExportSettingsOpen(false)

    let terminal = false
    try {
        const started = await mediaService.exportTrim(
          {
            inputPath: originalPath,
            timeline: exportScope === "timeline",
            outputPath: "",
            clips: clipsToExport,
            annotations,
            settings: exportSettings,
          },
        (progress) => {
          if (terminal) return
          const now = Date.now()
          setExportFeedback(previous => previous ? {
            ...previous, updatedAt: now,
            advancedAt: progress.progress !== previous.progress ? now : previous.advancedAt,
            sampleAt: previous.sampleAt === null || progress.progress < previous.progress ? now : previous.sampleAt,
            sampleProgress: previous.sampleAt === null || progress.progress < previous.progress ? progress.progress : previous.sampleProgress,
            progress: progress.progress,
            message: progress.status === "completed" ? "Результат сохранён" : progress.status === "cancelled" ? "Экспорт остановлен" : progress.message ?? previous.message,
          } : null)
          if (progress.operationId) setExportOperationId(progress.operationId)
          setExportProgress(progress.progress)

          if (progress.status === "completed" || progress.status === "failed" || progress.status === "cancelled") terminal = true
          if (progress.status === "completed") {
            setExportStatus("completed")
            setExportOperationId(null)
          } else if (progress.status === "cancelled") {
            setExportStatus("cancelled")
            setExportOperationId(null)
          } else if (progress.status === "failed") {
            setExportStatus("failed")
            setExportOperationId(null)
            setError({
              code: "EXPORT_FAILED",
              title: "Export failed",
              message: "FFmpeg could not export the selected range.",
              technicalDetails: progress.message,
              recoverable: true,
            })
          } else {
            setExportStatus("exporting")
          }
        },
      )

      if (!started.operationId) {
        setExportStatus("idle")
        setExportFeedback(null)
        return
      }

      setExportFeedback(previous => previous ? { ...previous, outputPath: started.outputPath, message: previous.sampleAt === null && !terminal ? "Кодировщик запущен. Ожидаем первые кадры…" : previous.message } : null)

      if (!terminal) {
        setExportOperationId(started.operationId)
        setExportStatus("exporting")
      }
    } catch (error) {
      setExportOperationId(null)
      setExportStatus("failed")
      setExportFeedback(previous => previous ? { ...previous, updatedAt: Date.now(), message: toMediaServiceError(error).message, cancelling: false } : null)
      setError(toMediaServiceError(error))
    }
  }, [
    annotations,
    mediaService,
    originalPath,
    exportSettings,
    exportScope,
    exportableClips,
    setError,
    setExportProgress,
    setExportStatus,
  ])

  const handleCancelExport = useCallback(async () => {
    if (!exportOperationId) return

    setExportFeedback(previous => previous ? { ...previous, cancelling: true } : null)
    try {
      await mediaService.cancelOperation(exportOperationId)
      // Wait for the terminal event before enabling another export.
    } catch (error) {
      setExportFeedback(previous => previous ? { ...previous, cancelling: false } : null)
      setError(toMediaServiceError(error))
    }
  }, [exportOperationId, mediaService, setError])

  const exportRunning = exportStatus === "preparing" || exportStatus === "exporting"
  const exportDisabled = !originalPath || exportRunning

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (discardDialog || useMediaStore.getState().isLoading) return
      const target = event.target as HTMLElement | null

      if (hasMedia && event.code === "Space" && !event.repeat && !isTextEditingTarget(target)) {
        event.preventDefault()
        event.stopPropagation()
        setPlaying(!isPlaying)
        return
      }

      if (isTextEditingTarget(target)) {
        return
      }

      const key = event.key.toLowerCase()
      const primary = event.ctrlKey || event.metaKey

      if (primary && key === "n") {
        event.preventDefault()
        void handleNewProject()
        return
      }

      if (primary && event.shiftKey && key === "o") {
        event.preventDefault()
        void handleOpenProject()
        return
      }

      if (primary && key === "o") {
        event.preventDefault()
        void handleOpenVideo()
        return
      }

      if (primary && key === "a") {
        event.preventDefault()
        selectAllClips()
        return
      }

      if (primary && key === "s") {
        event.preventDefault()
        if (hasMedia) {
          if (event.shiftKey) handleSaveAs()
          else handleSave()
        }
        return
      }

      if (primary && key === "e") {
        event.preventDefault()
        if (!exportDisabled) void handleExport()
        return
      }

      if (primary && event.shiftKey && key === "z") {
        event.preventDefault()
        if (redoStackRef.current.length > 0) redo()
        return
      }

      if (primary && key === "z") {
        event.preventDefault()
        if (undoStackRef.current.length > 0) undo()
        return
      }

      if (primary && key === "y") {
        event.preventDefault()
        if (redoStackRef.current.length > 0) redo()
        return
      }

      if (primary && key === "c") {
        if (selectedId) {
          event.preventDefault()
          copySelected()
        }
        return
      }

      if (primary && key === "x") {
        if (selectedId) {
          event.preventDefault()
          cutSelected()
        }
        return
      }

      if (primary && key === "v") {
        if (annotationClipboardRef.current) {
          event.preventDefault()
          pasteAnnotation()
        }
        return
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedId) {
          event.preventDefault()
          deleteSelected()
          return
        }
        if (selectedClipId || selectedRange) {
          event.preventDefault()
          deleteSelectedClip(event.shiftKey ? !rippleDelete : rippleDelete)
          return
        }
      }

      if (event.key === "Escape") { selectRange(null); return }
      if (hasMedia && primary && key === "b") { event.preventDefault(); splitSelectedClip(); return }

      if (hasMedia && primary && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault()
        const currentIndex = PLAYBACK_SPEEDS.findIndex((speed) => speed === playbackRate)
        const fallbackIndex = PLAYBACK_SPEEDS.reduce(
          (best, speed, index) =>
            Math.abs(speed - playbackRate) < Math.abs(PLAYBACK_SPEEDS[best] - playbackRate) ? index : best,
          0,
        )
        const index = currentIndex >= 0 ? currentIndex : fallbackIndex
        const direction = event.key === "ArrowRight" ? 1 : -1
        const nextIndex = Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, index + direction))
        setPlaybackRate(PLAYBACK_SPEEDS[nextIndex])
        markUnsaved()
        return
      }

      if (hasMedia && primary && (event.key === "+" || event.key === "=")) {
        event.preventDefault()
        setZoom((value) => Math.min(400, value + 25))
        return
      }

      if (hasMedia && primary && event.key === "-") {
        event.preventDefault()
        setZoom((value) => Math.max(25, value - 25))
        return
      }

      if (hasMedia && event.shiftKey && key === "z") {
        event.preventDefault()
        fitZoomToScreen()
        return
      }

      if (hasMedia && key === "m") {
        event.preventDefault()
        addMarker()
        return
      }

      const toolHotkeys: Partial<Record<string, ToolId>> = {
        v: "select",
        h: "move",
        p: "pen",
        b: "brush",
        a: "arrow",
        r: "rectangle",
        c: "circle",
        t: "text",
      }
      const nextTool = toolHotkeys[key]
      if (!primary && nextTool) {
        event.preventDefault()
        setActiveTool(nextTool)
        return
      }

      if (hasMedia && key === "s" && !primary) {
        event.preventDefault()
        splitSelectedClip()
        return
      }

      if (event.key === "F11") {
        event.preventDefault()
        toggleAppFullscreen()
      }
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [
    discardDialog,
    markUnsaved,
    addMarker,
    copySelected,
    cutSelected,
    deleteSelected,
    deleteSelectedClip,
    exportDisabled,
    fitZoomToScreen,
    handleExport,
    handleNewProject,
    handleOpenProject,
    handleOpenVideo,
    handleSave,
    handleSaveAs,
    hasMedia,
    isPlaying,
    pasteAnnotation,
    playbackRate,
    redo,
    selectAllClips,
    selectedId,
    selectedClipId,
    selectedRange,
    rippleDelete,
    selectRange,
    setPlaybackRate,
    setPlaying,
    splitSelectedClip,
    toggleAppFullscreen,
    undo,
  ])

  const canUndo = historyVersion >= 0 && undoStackRef.current.length > 0
  const canRedo = historyVersion >= 0 && redoStackRef.current.length > 0
  const canEditSelected = Boolean(selectedId)
  const canPasteAnnotation = Boolean(annotationClipboardRef.current && hasMedia)
  const currentFrame = Math.floor(currentTime * videoInfo.fps)
  const statusLabel = exportStatus === "idle" ? "Ready" : exportStatus
  const appTitle = projectPath
    ? `Project: ${projectPath}`
    : thumbnailCacheDir
      ? `Thumbnail cache: ${thumbnailCacheDir}`
      : undefined

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground" title={appTitle}>
      {discardDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" role="presentation">
          <section role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" className="max-w-md rounded-xl border border-border bg-card p-6 shadow-xl" onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); answerDiscard("cancel") }
            if (event.key === "Tab") {
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
              const next = (buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
              event.preventDefault(); buttons[next]?.focus()
            }
          }}>
            <h2 id="unsaved-title" className="text-lg font-semibold">Save your changes?</h2>
            <p className="my-4 text-sm text-muted-foreground">This project has unsaved changes.</p>
            <div className="flex gap-3">
              <button className="rounded bg-secondary px-3 py-2" onClick={() => answerDiscard("cancel")} autoFocus>Cancel</button>
              <button className="rounded bg-secondary px-3 py-2" onClick={() => answerDiscard("discard")}>Discard changes</button>
              <button className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => answerDiscard("save")}>Save changes</button>
            </div>
          </section>
        </div>
      )}
      {exportFeedback && exportStatus !== "idle" && <ExportProgressPanel
        status={exportStatus} progress={exportProgress} feedback={exportFeedback}
        canCancel={exportOperationId !== null} onCancel={handleCancelExport} onClose={() => setExportFeedback(null)}
      />}
      <MenuBar
        hasMedia={hasMedia}
        hasRecent={Boolean(recentMediaPath)}
        exportDisabled={exportDisabled}
        canUndo={canUndo}
        canRedo={canRedo}
        canCut={canEditSelected}
        canCopy={canEditSelected}
        canPaste={canPasteAnnotation}
        canDelete={canEditSelected || selectedClipIds.length > 0 || selectedRange !== null}
        canSelectAll={clips.length > 0}
        timelineVisible={timelineVisible}
        inspectorOpen={inspectorOpen}
        onNewProject={handleNewProject}
        onOpenVideo={handleOpenVideo}
        onOpenProject={handleOpenProject}
        onOpenRecent={handleOpenRecent}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onExport={handleExport}
        onUndo={undo}
        onRedo={redo}
        onCut={cutSelected}
        onCopy={copySelected}
        onPaste={pasteAnnotation}
        onDelete={() => selectedId ? deleteSelected() : deleteSelectedClip()}
        onSelectAll={selectAllClips}
        onZoomIn={() => setZoom((value) => Math.min(400, value + 25))}
        onZoomOut={() => setZoom((value) => Math.max(25, value - 25))}
        onFitToScreen={fitZoomToScreen}
        onToggleTimeline={() => setTimelineVisible((visible) => !visible)}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        onToggleFullscreen={toggleAppFullscreen}
        onSelectTrimTool={() => {
          setTimelineVisible(true)
          setActiveTool("select")
        }}
        onSplitClip={splitSelectedClip}
        onAddMarker={addMarker}
        onOpenExportSettings={() => setExportSettingsOpen(true)}
      />
      <Toolbar
        hasMedia={hasMedia}
        zoom={zoom}
        onZoomChange={setZoom}
        onOpenVideo={handleOpenVideo}
        onExport={handleExport}
        onCancelExport={handleCancelExport}
        exportRunning={exportRunning}
        exportDisabled={exportDisabled}
        onSave={handleSave}
        onSplitClip={splitSelectedClip}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
      />
      {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
      {isLoading && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/55 backdrop-blur-[2px]">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-2xl">
            <LoaderCircle className="size-5 animate-spin text-primary" />
            <div>
              <div className="text-sm font-medium text-foreground">Loading media</div>
              <div className="text-xs text-muted-foreground">
                Selecting file and analyzing video metadata…
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ToolSidebar
          annotationsDisabled={!hasMedia || videoInfo.hasVideo === false}
          active={activeTool}
          onSelect={setActiveTool}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <Preview
              clips={clips}
              playbackCopy={playbackCopy.state}
              playbackCopyProgress={performanceConfig?.playbackProxy?.videoId === videoCacheId ? performanceConfig.playbackProxy.progress : 0}
              onPreparePlayback={() => { void playbackCopy.start() }}
              onPlaybackError={playbackCopy.recover}
              onCancelPlaybackCopy={playbackCopy.cancel}
              onTogglePlaybackCopy={() => { void playbackCopy.toggle() }}
              videoInfo={videoInfo}
              frameSourcePath={playbackCopy.state.active ? playbackCopy.state.path ?? originalPath : originalPath}
              mediaSession={mediaSession}
              seekFrameTime={seekFrameTime}
              playbackUrl={playbackUrl}
              currentTime={currentTime}
              seekRevision={seekRevision}
              seekTarget={seekTarget}
              seekMode={seekMode}
              duration={effectiveDuration}
              isPlaying={isPlaying}
              onTogglePlay={() => setPlaying(!isPlaying)}
              onEnded={() => setPlaying(false)}
              onSeek={handleUserSeek}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={synchronizePlaybackTime}
              zoom={zoom}
              onZoomChange={setZoom}
              playbackSpeed={String(playbackRate)}
              onPlaybackSpeedChange={(value) => { setPlaybackRate(Number.parseFloat(value)); markUnsaved() }}
              volume={volume * 100}
              onVolumeChange={(value) => { setVolume(value / 100); markUnsaved() }}
              activeTool={activeTool}
              annotations={annotations}
              selectedId={selectedId}
              onSelectAnnotation={setSelectedId}
              onCreateAnnotation={createAnnotation}
              onEditStart={beginEdit}
              onUpdateAnnotation={patchAnnotation}
              onOpenVideo={handleOpenVideo}
              hasMedia={hasMedia}
              isLoading={isLoading}
              onPerformanceMetrics={handlePerformanceMetrics}
            />
            {inspectorOpen ? (
              <Inspector
                videoInfo={videoInfo}
                selected={selected}
                onEditStart={beginEdit}
                onEditEnd={endEdit}
                onChange={updateSelected}
                onDelete={deleteSelected}
                onClose={() => setInspectorOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setInspectorOpen(true)}
                className="flex w-9 shrink-0 items-center justify-center border-l border-border bg-sidebar text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
                aria-label="Open inspector"
              >
                <PanelRightOpen className="size-4" />
              </button>
            )}
          </div>

          {hasMedia && timelineVisible && (
            <div className="h-72 shrink-0 border-t border-border">
              <Timeline
                sourceDuration={duration}
                selectedRange={selectedRange}
                onSelectRange={selectRange}
                onMoveClips={moveSelectedClips}
                onMoveRange={moveSelectedRange}
                rippleDelete={rippleDelete}
                onRippleDeleteChange={setRippleDelete}
                duration={effectiveDuration}
                playbackUrl={playbackUrl}
                originalPath={originalPath}
                videoId={videoCacheId}
                mediaService={mediaService}
                videoInfo={videoInfo}
                isPlaying={isPlaying}
                onSeek={handleUserSeek}
                pxPerSecond={pxPerSecond}
                onPxPerSecondChange={setPxPerSecond}
                markers={markers}
                clips={clips}
                selectedClipId={selectedClipId}
                selectedClipIds={selectedClipIds}
                onSelectClip={selectClip}
                onSplitClip={splitSelectedClip}
                onDeleteClip={deleteSelectedClip}
                annotations={annotations}
                selectedId={selectedId}
                onSelectAnnotation={setSelectedId}
                onEditStart={beginEdit}
                onUpdateAnnotation={patchAnnotation}
                trim={trim}
                onTrimChange={handleTrimChange}
                onAddMarker={addMarker}
                onCacheDirChange={setThumbnailCacheDir}
              />
            </div>
          )}
        </div>
      </div>

      <StatusBar
        hasMedia={hasMedia}
        currentFrame={currentFrame}
        fps={videoInfo.fps}
        variableFps={videoInfo.variableFps}
        currentTime={currentTime}
        isPlaying={isPlaying}
        saved={saved}
        exportStatus={statusLabel}
        exportProgress={exportProgress}
      />
      <ExportSettingsPanel
        open={exportSettingsOpen}
        clips={clips}
        selectedClipId={selectedClipId}
        selectedClipIds={selectedClipIds}
        settings={exportSettings}
        scope={exportScope}
        exportRunning={exportRunning}
        onSettingsChange={(settings) => { setExportSettings(settings); markUnsaved() }}
        onScopeChange={(scope) => { setExportScope(scope); markUnsaved() }}
        onClose={() => setExportSettingsOpen(false)}
        onExport={handleExport}
      />
    </div>
  )
}

export default App
