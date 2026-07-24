"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { LoaderCircle, PanelRightOpen } from "lucide-react"
import { MenuBar } from "@/components/editor/menu-bar"
import { Toolbar } from "@/components/editor/toolbar"
import { ToolSidebar } from "@/components/editor/tool-sidebar"
import { Preview } from "@/components/editor/preview"
import { Inspector } from "@/components/editor/inspector"
import { Timeline } from "@/components/editor/timeline"
import { StatusBar } from "@/components/editor/status-bar"
import { ExportSettingsPanel } from "@/components/editor/export-settings-panel"
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
import type { ExportSettings } from "@/types/export"
import type { OpenMediaResult } from "@/types/media"

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
const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "mp4",
  mode: "stream-copy",
  videoCodec: "h264",
  audioCodec: "aac",
  videoBitrateKbps: null,
  audioBitrateKbps: 192,
  fps: null,
  width: null,
  height: null,
  crf: 20,
  preset: "medium",
}

type ProjectSnapshot = {
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
  return annotations.map((annotation) => ({ ...annotation }))
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
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [exportOperationId, setExportOperationId] = useState<string | null>(null)
  const [mediaDetails, setMediaDetails] = useState<VideoInfo>(EMPTY_VIDEO_INFO)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [timelineVisible, setTimelineVisible] = useState(true)
  const [videoCacheId, setVideoCacheId] = useState<string | null>(null)
  const [thumbnailCacheDir, setThumbnailCacheDir] = useState<string | null>(null)
  const [recentMediaPath, setRecentMediaPath] = useState<string | null>(null)
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const [exportScope, setExportScope] = useState<"selected" | "all">("selected")
  const undoStackRef = useRef<ProjectSnapshot[]>([])
  const redoStackRef = useRef<ProjectSnapshot[]>([])
  const annotationClipboardRef = useRef<Annotation | null>(null)
  const lastPressureRef = useRef<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  const [annotations, setAnnotations] = useState<Annotation[]>(INITIAL_ANNOTATIONS)
  const [markers, setMarkers] = useState<TimelineMarker[]>(INITIAL_MARKERS)
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pxPerSecond, setPxPerSecond] = useState(14)
  const [seekRevision, setSeekRevision] = useState(0)

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

  const mediaService = getMediaService()
  const hasMedia = Boolean(originalPath && playbackUrl)
  const effectiveDuration = hasMedia && duration > 0 ? duration : 0
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null
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
    (metrics: { droppedFrameRatio: number; userActive: boolean; windowVisible: boolean }) => {
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

  const fileNameFromPath = useCallback((path: string) => path.split(/[\\/]/).pop() || path, [])

  const synchronizePlaybackTime = useCallback(
    (time: number) => {
      playbackClock.set(time)
      setCurrentTime(time)
    },
    [setCurrentTime],
  )

  const handleUserSeek = useCallback(
    (time: number) => {
      synchronizePlaybackTime(time)
      setSeekRevision((revision) => revision + 1)
    },
    [synchronizePlaybackTime],
  )

  const createSnapshot = useCallback(
    (): ProjectSnapshot => ({
      annotations: cloneAnnotations(annotations),
      markers: cloneMarkers(markers),
      clips: cloneClips(clips),
      selectedClipId,
      selectedClipIds: [...selectedClipIds],
      selectedId,
      trimStart,
      trimEnd,
    }),
    [annotations, clips, markers, selectedClipId, selectedClipIds, selectedId, trimEnd, trimStart],
  )

  const applySnapshot = useCallback(
    (snapshot: ProjectSnapshot) => {
      setAnnotations(cloneAnnotations(snapshot.annotations))
      setMarkers(cloneMarkers(snapshot.markers))
      setClips(cloneClips(snapshot.clips))
      setSelectedClipId(snapshot.selectedClipId)
      setSelectedClipIds([...snapshot.selectedClipIds])
      setSelectedId(snapshot.selectedId)
      setTrimStart(snapshot.trimStart)
      setTrimEnd(snapshot.trimEnd)
      setSaved(false)
    },
    [setTrimEnd, setTrimStart],
  )

  const pushHistory = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current.slice(-99), createSnapshot()]
    redoStackRef.current = []
    setHistoryVersion((version) => version + 1)
  }, [createSnapshot])

  const selectClip = useCallback((clipId: string, additive = false) => {
    setSelectedClipIds((prev) => {
      if (!additive) {
        setSelectedClipId(clipId)
        return [clipId]
      }
      if (prev.includes(clipId)) {
        const next = prev.filter((id) => id !== clipId)
        const selection = next.length > 0 ? next : [clipId]
        setSelectedClipId(selection[selection.length - 1])
        return selection
      }
      setSelectedClipId(clipId)
      return [...prev, clipId]
    })
  }, [])

  const undo = useCallback(() => {
    const snapshot = undoStackRef.current.pop()
    if (!snapshot) return

    redoStackRef.current = [...redoStackRef.current.slice(-99), createSnapshot()]
    applySnapshot(snapshot)
    setHistoryVersion((version) => version + 1)
  }, [applySnapshot, createSnapshot])

  const redo = useCallback(() => {
    const snapshot = redoStackRef.current.pop()
    if (!snapshot) return

    undoStackRef.current = [...undoStackRef.current.slice(-99), createSnapshot()]
    applySnapshot(snapshot)
    setHistoryVersion((version) => version + 1)
  }, [applySnapshot, createSnapshot])

  const applyMedia = useCallback(
    (media: OpenMediaResult, project?: ProjectFile) => {
      setVideoCacheId(null)
      setThumbnailCacheDir(null)
      loadMedia(media)
      playbackClock.set(0)
      setMediaDetails({
        ...EMPTY_VIDEO_INFO,
        filename: media.fileName,
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
      const restoredClips = project?.clips?.length ? numberClipLabels(project.clips) : [initialClip]
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
      void mediaService
        .createVideoCacheId(media.originalPath)
        .then(setVideoCacheId)
        .catch(() => setVideoCacheId(`video-${Date.now()}`))
    },
    [loadMedia, mediaService, setPlaybackRate, setVolume],
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
    setSaved(false)
  }, [currentTime, hasMedia, pushHistory])

  const handleOpenVideo = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      if (playbackUrl) await mediaService.closeMedia(playbackUrl)
      const media = await mediaService.openMedia()
      if (media) {
        applyMedia(media)
        setProjectPath(null)
      }
    } catch (error) {
      setError(toMediaServiceError(error))
    } finally {
      setLoading(false)
    }
  }, [applyMedia, mediaService, playbackUrl, setError, setLoading])

  const handleOpenRecent = useCallback(async () => {
    if (!recentMediaPath) return

    setLoading(true)
    setError(null)

    try {
      if (playbackUrl) await mediaService.closeMedia(playbackUrl)
      const probe = await mediaService.probeMedia(recentMediaPath)
      const media: OpenMediaResult = {
        originalPath: recentMediaPath,
        playbackUrl: await mediaService.preparePlayback(recentMediaPath),
        fileName: fileNameFromPath(recentMediaPath),
        probe,
      }
      applyMedia(media)
      setProjectPath(null)
    } catch (error) {
      setError(toMediaServiceError(error))
    } finally {
      setLoading(false)
    }
  }, [applyMedia, fileNameFromPath, mediaService, playbackUrl, recentMediaPath, setError, setLoading])

  const handleNewProject = useCallback(async () => {
    if (playbackUrl) await mediaService.closeMedia(playbackUrl)
    closeMedia()
    playbackClock.set(0)
    setMediaDetails(EMPTY_VIDEO_INFO)
    setVideoCacheId(null)
    setThumbnailCacheDir(null)
    setAnnotations([])
    setMarkers([])
    setClips([])
    setSelectedClipId(null)
    setSelectedClipIds([])
    setSelectedId(null)
    setPxPerSecond(14)
    setZoom(100)
    setProjectPath(null)
    setInspectorOpen(true)
    setTimelineVisible(true)
    undoStackRef.current = []
    redoStackRef.current = []
    annotationClipboardRef.current = null
    setHistoryVersion((version) => version + 1)
    setSaved(true)
    setError(null)
  }, [closeMedia, mediaService, playbackUrl, setError])

  const createProjectFile = useCallback(
    (): ProjectFile | null => {
      if (!originalPath) return null
      return {
        version: 1,
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
      await writeProject(path, project)
      setProjectPath(path)
      setSaved(true)
    },
    [createProjectFile],
  )

  const handleSaveAs = useCallback(async () => {
    if (!hasMedia) return
    setError(null)
    try {
      const fallbackName = `${(fileName ?? "project").replace(/\.[^/.]+$/, "")}.lumen.json`
      const path = await chooseProjectToSave(fallbackName)
      if (path) await saveProjectToPath(path)
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
      await handleSaveAs()
      return
    }
    setError(null)
    try {
      await saveProjectToPath(projectPath)
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

  const handleOpenProject = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const path = await chooseProjectToOpen()
      if (!path) return

      if (playbackUrl) await mediaService.closeMedia(playbackUrl)
      const project = await readProject(path)
      const probe = await mediaService.probeMedia(project.mediaPath)
      const media: OpenMediaResult = {
        originalPath: project.mediaPath,
        playbackUrl: await mediaService.preparePlayback(project.mediaPath),
        fileName: fileNameFromPath(project.mediaPath),
        probe,
      }
      applyMedia(media, project)
      setProjectPath(path)
      setSaved(true)
    } catch (error) {
      setError(
        createAppError({
          code: "PROJECT_OPEN_FAILED",
          title: "Project was not opened",
          message: "The project file or its source video could not be loaded.",
          technicalDetails: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
      )
    } finally {
      setLoading(false)
    }
  }, [applyMedia, fileNameFromPath, mediaService, playbackUrl, setError, setLoading])

  const fitZoomToScreen = useCallback(() => {
    setZoom(100)
  }, [])

  const handleLoadedMetadata = useCallback(
    (metadata: { duration: number; resolution: string }) => {
      setDuration(metadata.duration)
      setMediaDetails((details) => ({
        ...details,
        duration: metadata.duration,
        resolution: metadata.resolution,
      }))
      setClips((currentClips) => {
        if (currentClips.length === 0) {
          const clip = {
            id: `clip-${Date.now()}`,
            label: "Clip 1",
            startTime: 0,
            endTime: metadata.duration,
          }
          setSelectedClipId(clip.id)
          setSelectedClipIds([clip.id])
          return [clip]
        }

        return currentClips.map((clip, index) =>
          index === 0 && clip.endTime <= 0 ? { ...clip, endTime: metadata.duration } : clip,
        )
      })

    },
    [setDuration],
  )

  const selected = annotations.find((a) => a.id === selectedId) ?? null

  const updateSelected = useCallback(
    (patch: Partial<Annotation>) => {
      if (!selectedId) return
      pushHistory()
      setAnnotations((prev) => prev.map((a) => (a.id === selectedId ? { ...a, ...patch } : a)))
      setSaved(false)
    },
    [pushHistory, selectedId],
  )

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    pushHistory()
    setAnnotations((prev) => prev.filter((a) => a.id !== selectedId))
    setSelectedId(null)
    setSaved(false)
  }, [pushHistory, selectedId])

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
      x: Math.min(0.95, source.x + 0.03),
      y: Math.min(0.95, source.y + 0.03),
    }
    setAnnotations((prev) => [...prev, pasted])
    setSelectedId(pasted.id)
    setSaved(false)
  }, [currentTime, effectiveDuration, hasMedia, pushHistory])

  const createAnnotation = useCallback(
    (annotation: Annotation) => {
      if (!hasMedia) return
      pushHistory()
      setAnnotations((prev) => [...prev, annotation])
      setSelectedId(annotation.id)
      setSaved(false)
    },
    [hasMedia, pushHistory],
  )

  const patchAnnotation = useCallback((id: string, patch: Partial<Annotation>) => {
    setAnnotations((prev) => prev.map((annotation) => (annotation.id === id ? { ...annotation, ...patch } : annotation)))
    setSaved(false)
  }, [])

  const handleTrimChange = useCallback(
    ([start, end]: [number, number]) => {
      pushHistory()
      setClips((prev) =>
        prev.map((clip) =>
          clip.id === selectedClipId ? { ...clip, startTime: start, endTime: end } : clip,
        ),
      )
      setTrimStart(start)
      setTrimEnd(end)
      setSaved(false)
    },
    [pushHistory, selectedClipId, setTrimEnd, setTrimStart],
  )

  const splitSelectedClip = useCallback(() => {
    if (!selectedClip || currentTime <= selectedClip.startTime || currentTime >= selectedClip.endTime) return

    pushHistory()
    const nextClipId = `clip-${Date.now()}`
    setClips((prev) =>
      numberClipLabels(prev.flatMap((clip) => {
        if (clip.id !== selectedClip.id) return [clip]
        return [
          {
            ...clip,
            endTime: currentTime,
          },
          {
            id: nextClipId,
            label: clip.label,
            startTime: currentTime,
            endTime: clip.endTime,
          },
        ]
      })),
    )
    setSelectedClipId(nextClipId)
    setSelectedClipIds([nextClipId])
    setSaved(false)
  }, [currentTime, pushHistory, selectedClip])

  const deleteSelectedClip = useCallback(() => {
    const selectedIds = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : []
    if (selectedIds.length === 0 || clips.length <= selectedIds.length) return

    pushHistory()
    setClips((prev) => {
      const next = numberClipLabels(prev.filter((clip) => !selectedIds.includes(clip.id)))
      setSelectedClipId(next[0]?.id ?? null)
      setSelectedClipIds(next[0] ? [next[0].id] : [])
      return next
    })
    setSaved(false)
  }, [clips.length, pushHistory, selectedClipId, selectedClipIds])

  const selectAllClips = useCallback(() => {
    if (clips.length === 0) return
    const ids = clips.map((clip) => clip.id)
    setSelectedClipIds(ids)
    setSelectedClipId(ids[ids.length - 1])
  }, [clips])

  const exportableClips = useCallback(() => {
    const selectedSet = new Set(selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [])
    const sourceClips = exportScope === "all" ? clips : clips.filter((clip) => selectedSet.has(clip.id))
    return sourceClips
      .filter((clip) => clip.endTime > clip.startTime)
      .map((clip) => ({
        id: clip.id,
        label: clip.label,
        startTime: clip.startTime,
        endTime: clip.endTime,
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
    if (!originalPath) {
      setError({
        code: "NO_MEDIA",
        title: "No video selected",
        message: "Open a local video before exporting a trim range.",
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

    try {
        const started = await mediaService.exportTrim(
          {
            inputPath: originalPath,
            outputPath: "",
            clips: clipsToExport,
            annotations,
            settings: exportSettings,
          },
        (progress) => {
          if (progress.operationId) setExportOperationId(progress.operationId)
          setExportProgress(progress.progress)

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
        return
      }

      setExportOperationId(started.operationId)
      setExportStatus("exporting")
    } catch (error) {
      setExportOperationId(null)
      setExportStatus("failed")
      setError(toMediaServiceError(error))
    }
  }, [
    annotations,
    mediaService,
    originalPath,
    exportSettings,
    exportableClips,
    setError,
    setExportProgress,
    setExportStatus,
  ])

  const handleCancelExport = useCallback(async () => {
    if (!exportOperationId) return

    try {
      await mediaService.cancelOperation(exportOperationId)
      setExportOperationId(null)
      setExportStatus("cancelled")
    } catch (error) {
      setError(toMediaServiceError(error))
    }
  }, [exportOperationId, mediaService, setError, setExportStatus])

  const exportRunning = exportStatus === "preparing" || exportStatus === "exporting"
  const exportDisabled = !originalPath || exportRunning

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName

      if (hasMedia && event.code === "Space" && !event.repeat && !isTextEditingTarget(target)) {
        event.preventDefault()
        event.stopPropagation()
        setPlaying(!isPlaying)
        return
      }

      if (
        target?.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      ) {
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

      if (event.key === "Delete") {
        if (selectedId) {
          event.preventDefault()
          deleteSelected()
          return
        }
        if (selectedClipId) {
          event.preventDefault()
          deleteSelectedClip()
          return
        }
      }

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
    setPlaybackRate,
    setPlaying,
    splitSelectedClip,
    toggleAppFullscreen,
    undo,
  ])

  /* eslint-disable react-hooks/refs -- historyVersion explicitly invalidates these command-state refs. */
  const canUndo = historyVersion >= 0 && undoStackRef.current.length > 0
  const canRedo = historyVersion >= 0 && redoStackRef.current.length > 0
  const canEditSelected = Boolean(selectedId)
  const canPasteAnnotation = Boolean(annotationClipboardRef.current && hasMedia)
  /* eslint-enable react-hooks/refs */
  const currentFrame = Math.floor(currentTime * videoInfo.fps)
  const statusLabel = exportStatus === "idle" ? "Ready" : exportStatus
  const appTitle = projectPath
    ? `Project: ${projectPath}`
    : thumbnailCacheDir
      ? `Thumbnail cache: ${thumbnailCacheDir}`
      : undefined

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground" title={appTitle}>
      <MenuBar
        hasMedia={hasMedia}
        hasRecent={Boolean(recentMediaPath)}
        exportDisabled={exportDisabled}
        canUndo={canUndo}
        canRedo={canRedo}
        canCut={canEditSelected}
        canCopy={canEditSelected}
        canPaste={canPasteAnnotation}
        canDelete={canEditSelected}
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
        onDelete={deleteSelected}
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
          active={activeTool}
          onSelect={setActiveTool}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <Preview
              videoInfo={videoInfo}
              playbackUrl={playbackUrl}
              currentTime={currentTime}
              seekRevision={seekRevision}
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
              onPlaybackSpeedChange={(value) => setPlaybackRate(Number.parseFloat(value))}
              volume={volume * 100}
              onVolumeChange={(value) => setVolume(value / 100)}
              activeTool={activeTool}
              annotations={annotations}
              selectedId={selectedId}
              onSelectAnnotation={setSelectedId}
              onCreateAnnotation={createAnnotation}
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
            <div className="h-64 shrink-0 border-t border-border">
              <Timeline
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
        onSettingsChange={setExportSettings}
        onScopeChange={setExportScope}
        onClose={() => setExportSettingsOpen(false)}
        onExport={handleExport}
      />
    </div>
  )
}

export default App
