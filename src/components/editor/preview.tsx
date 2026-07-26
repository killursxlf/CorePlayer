"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  FileVideo,
  FolderOpen,
  Play,
  SkipBack,
  SkipForward,
  ChevronsLeft,
  ChevronsRight,
  Rewind,
  FastForward,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Gauge,
} from "lucide-react"
import type { Annotation, AnnotationType, ToolId, VideoInfo } from "@/lib/editor-types"
import { formatTimecode } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { playbackClock } from "@/stores/playback-clock"

const SPEEDS = ["0.25", "0.5", "1", "1.5", "2"]

interface PreviewProps {
  videoInfo: VideoInfo
  playbackUrl: string | null
  currentTime: number
  seekRevision: number
  duration: number
  isPlaying: boolean
  onTogglePlay: () => void
  onEnded: () => void
  onSeek: (t: number) => void
  onLoadedMetadata: (metadata: { duration: number; resolution: string }) => void
  onTimeUpdate: (currentTime: number) => void
  zoom: number
  onZoomChange: (v: number) => void
  playbackSpeed: string
  onPlaybackSpeedChange: (v: string) => void
  volume: number
  onVolumeChange: (v: number) => void
  activeTool: ToolId
  annotations: Annotation[]
  selectedId: string | null
  onSelectAnnotation: (id: string | null) => void
  onCreateAnnotation: (annotation: Annotation) => void
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void
  onOpenVideo: () => void
  hasMedia: boolean
  isLoading: boolean
  onPerformanceMetrics?: (metrics: {
    droppedFrameRatio: number
    userActive: boolean
    windowVisible: boolean
  }) => void
}

type NormalizedPoint = { x: number; y: number }
type DraftAnnotation = {
  type: AnnotationType
  start: NormalizedPoint
  end: NormalizedPoint
  points?: NormalizedPoint[]
}

const drawingTools = new Set<ToolId>([
  "pen",
  "brush",
  "arrow",
  "rectangle",
  "circle",
  "blur",
  "highlight",
  "text",
  "crop",
  "measure",
])

const annotationToolTypes: Partial<Record<ToolId, AnnotationType>> = {
  pen: "pen",
  brush: "brush",
  arrow: "arrow",
  rectangle: "rectangle",
  circle: "circle",
  blur: "blur",
  highlight: "highlight",
  text: "text",
  crop: "crop",
  measure: "measure",
}

function pointFromEvent(event: React.PointerEvent | PointerEvent, element: HTMLElement): NormalizedPoint {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  }
}

function annotationBox(start: NormalizedPoint, end: NormalizedPoint) {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.max(0.015, Math.abs(end.x - start.x))
  const height = Math.max(0.015, Math.abs(end.y - start.y))
  return { x, y, width, height }
}

function pointsBox(points: NormalizedPoint[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const width = Math.max(0.015, maxX - x)
  const height = Math.max(0.015, maxY - y)
  return { x, y, width, height }
}

function normalizePathPoints(points: NormalizedPoint[], box: { x: number; y: number; width: number; height: number }) {
  return points.map((point) => ({
    x: (point.x - box.x) / box.width,
    y: (point.y - box.y) / box.height,
  }))
}

function lineGeometry(start: NormalizedPoint, end: NormalizedPoint) {
  const box = annotationBox(start, end)
  return {
    lineStartX: (start.x - box.x) / box.width,
    lineStartY: (start.y - box.y) / box.height,
    lineEndX: (end.x - box.x) / box.width,
    lineEndY: (end.y - box.y) / box.height,
  }
}

function defaultStyleForType(type: AnnotationType) {
  switch (type) {
    case "blur":
      return { color: "#7dd3fc", opacity: 70, thickness: 2 }
    case "highlight":
      return { color: "#eab308", opacity: 36, thickness: 2 }
    case "text":
      return { color: "#ffffff", opacity: 100, thickness: 10 }
    case "crop":
      return { color: "#22c55e", opacity: 100, thickness: 2 }
    case "measure":
      return { color: "#f97316", opacity: 100, thickness: 2 }
    case "pen":
      return { color: "#3b82f6", opacity: 100, thickness: 2 }
    case "brush":
      return { color: "#ef4444", opacity: 88, thickness: 8 }
    default:
      return { color: "#3b82f6", opacity: 100, thickness: 3 }
  }
}

function buildAnnotation(
  type: AnnotationType,
  start: NormalizedPoint,
  end: NormalizedPoint,
  currentTime: number,
  duration: number,
  points?: NormalizedPoint[],
): Annotation {
  const style = defaultStyleForType(type)
  const box =
    (type === "brush" || type === "pen") && points && points.length > 1
      ? pointsBox(points)
      : annotationBox(start, end)
  const visibleEnd = duration > 0 ? Math.min(duration, currentTime + 5) : currentTime + 5
  return {
    id: `a${Date.now()}`,
    type,
    label: type === "text" ? "Text" : type === "measure" ? "Measure" : type === "crop" ? "Crop" : type,
    color: style.color,
    opacity: style.opacity,
    thickness: style.thickness,
    font: "Inter",
    visible: true,
    startTime: currentTime,
    endTime: Math.max(currentTime + 0.25, visibleEnd),
    ...box,
    ...(type === "arrow" || type === "measure" ? lineGeometry(start, end) : {}),
    ...((type === "brush" || type === "pen") && points && points.length > 1
      ? { pathPoints: normalizePathPoints(points, box) }
      : {}),
  }
}

function linePoints(annotation: Annotation) {
  return {
    x1: `${((annotation.lineStartX ?? 0.06) * 100).toFixed(2)}%`,
    y1: `${((annotation.lineStartY ?? 0.9) * 100).toFixed(2)}%`,
    x2: `${((annotation.lineEndX ?? 0.94) * 100).toFixed(2)}%`,
    y2: `${((annotation.lineEndY ?? 0.1) * 100).toFixed(2)}%`,
  }
}

function pathData(points: NormalizedPoint[] | undefined) {
  if (!points || points.length === 0) return ""
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${(point.x * 100).toFixed(2)} ${(point.y * 100).toFixed(2)}`)
    .join(" ")
}

function AnnotationOverlay({
  a,
  selected,
  activeTool,
  onClick,
  onMoveStart,
}: {
  a: Annotation
  selected: boolean
  activeTool: ToolId
  onClick: () => void
  onMoveStart: (event: React.PointerEvent, annotation: Annotation) => void
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    left: `${a.x * 100}%`,
    top: `${a.y * 100}%`,
    width: `${a.width * 100}%`,
    height: `${a.height * 100}%`,
    opacity: a.type === "blur" ? 1 : a.opacity / 100,
  }
  const ring = selected ? "0 0 0 2px var(--color-primary)" : "none"
  const points = linePoints(a)

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        if (activeTool === "move") {
          onMoveStart(event, a)
        }
      }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={base}
      className="group/annotation cursor-pointer"
      aria-label={a.label}
    >
      {a.type === "rectangle" && (
        <div
          className="size-full rounded-sm"
          style={{ border: `${a.thickness}px solid ${a.color}`, boxShadow: ring }}
        />
      )}
      {a.type === "circle" && (
        <div
          className="size-full rounded-full"
          style={{ border: `${a.thickness}px solid ${a.color}`, boxShadow: ring }}
        />
      )}
      {a.type === "highlight" && (
        <div
          className="size-full rounded-sm"
          style={{ backgroundColor: a.color, boxShadow: ring }}
        />
      )}
      {a.type === "blur" && (
        <div
          className="size-full rounded-sm"
          style={{
            border: `1px dashed ${a.color}`,
            boxShadow: ring,
            backdropFilter: `blur(${Math.max(4, a.thickness * 2)}px)`,
            WebkitBackdropFilter: `blur(${Math.max(4, a.thickness * 2)}px)`,
            backgroundColor: `rgba(255,255,255,${Math.max(0.04, a.opacity / 500)})`,
          }}
        />
      )}
      {a.type === "crop" && (
        <div
          className="size-full rounded-sm bg-black/5"
          style={{ border: `${Math.max(1, a.thickness)}px dashed ${a.color}`, boxShadow: ring }}
        />
      )}
      {a.type === "arrow" && (
        <svg className="size-full overflow-visible" style={{ filter: selected ? "drop-shadow(0 0 2px var(--color-primary))" : undefined }}>
          <defs>
            <marker id={`arrow-${a.id}`} markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill={a.color} />
            </marker>
          </defs>
          <line
            x1={points.x1}
            y1={points.y1}
            x2={points.x2}
            y2={points.y2}
            stroke={a.color}
            strokeWidth={a.thickness}
            strokeLinecap="round"
            markerEnd={`url(#arrow-${a.id})`}
          />
        </svg>
      )}
      {a.type === "measure" && (
        <svg className="size-full overflow-visible" style={{ filter: selected ? "drop-shadow(0 0 2px var(--color-primary))" : undefined }}>
          <line
            x1={points.x1}
            y1={points.y1}
            x2={points.x2}
            y2={points.y2}
            stroke={a.color}
            strokeWidth={a.thickness}
            strokeLinecap="round"
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x="50%"
            y="45%"
            textAnchor="middle"
            fill={a.color}
            fontSize="11"
            fontWeight="700"
            paintOrder="stroke"
            stroke="black"
            strokeWidth="3"
          >
            {a.label}
          </text>
        </svg>
      )}
      {a.type === "text" && (
        <div
          className="flex size-full items-center justify-center rounded-sm px-1 text-center font-semibold"
          style={{ color: a.color, fontSize: `${a.thickness + 6}px`, boxShadow: ring }}
        >
          {a.label}
        </div>
      )}
      {(a.type === "brush" || a.type === "pen") && (
        <svg className="size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            d={pathData(a.pathPoints) || "M 5 50 Q 25 10 50 50 T 95 50"}
            fill="none"
            stroke={a.color}
            strokeWidth={a.thickness}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={a.type === "brush" ? 0.88 : 1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </button>
  )
}

function ControlButton({
  label,
  onClick,
  children,
  className,
  disabled,
}: {
  label: string
  onClick?: () => void
  children: React.ReactNode
  className?: string
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              className,
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function DraftOverlay({ draft }: { draft: DraftAnnotation }) {
  if ((draft.type === "brush" || draft.type === "pen") && draft.points && draft.points.length > 1) {
    const style = defaultStyleForType(draft.type)
    return (
      <svg
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <path
          d={pathData(draft.points)}
          fill="none"
          stroke={style.color}
          strokeWidth={style.thickness}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={draft.type === "brush" ? 0.88 : 1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  const box = annotationBox(draft.start, draft.end)
  const style = defaultStyleForType(draft.type)
  const base: React.CSSProperties = {
    position: "absolute",
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
    pointerEvents: "none",
    opacity: Math.max(0.25, style.opacity / 100),
  }

  if (draft.type === "circle") {
    return <div style={base} className="rounded-full border-2 border-primary bg-primary/10" />
  }

  if (draft.type === "arrow" || draft.type === "measure") {
    const geometry = lineGeometry(draft.start, draft.end)
    return (
      <svg style={base} className="overflow-visible">
        <line
          x1={`${geometry.lineStartX * 100}%`}
          y1={`${geometry.lineStartY * 100}%`}
          x2={`${geometry.lineEndX * 100}%`}
          y2={`${geometry.lineEndY * 100}%`}
          stroke={style.color}
          strokeWidth={style.thickness}
          strokeDasharray={draft.type === "measure" ? "5 4" : undefined}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  return (
    <div
      style={base}
      className={cn(
        "rounded-sm border-2",
        draft.type === "crop" ? "border-dashed border-chart-3 bg-black/5" : "border-primary bg-primary/10",
        draft.type === "highlight" && "bg-yellow-300/30",
        draft.type === "blur" && "border-dashed backdrop-blur-sm",
      )}
    />
  )
}

export function Preview({
  videoInfo,
  playbackUrl,
  currentTime,
  seekRevision,
  duration,
  isPlaying,
  onTogglePlay,
  onEnded,
  onSeek,
  onLoadedMetadata,
  onTimeUpdate,
  zoom,
  onZoomChange,
  playbackSpeed,
  onPlaybackSpeedChange,
  volume,
  onVolumeChange,
  activeTool,
  annotations,
  selectedId,
  onSelectAnnotation,
  onCreateAnnotation,
  onUpdateAnnotation,
  onOpenVideo,
  hasMedia,
  isLoading,
  onPerformanceMetrics,
}: PreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastAudibleVolumeRef = useRef(80)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [zoomOrigin, setZoomOrigin] = useState("50% 50%")
  const [draft, setDraft] = useState<DraftAnnotation | null>(null)
  const [didDragTool, setDidDragTool] = useState(false)
  const [isSeekingMedia, setIsSeekingMedia] = useState(false)
  const [seekError, setSeekError] = useState<string | null>(null)
  const frame = 1 / videoInfo.fps
  const visibleAnnotations = annotations.filter(
    (a) => a.visible && currentTime >= a.startTime && currentTime <= a.endTime,
  )

  const toggleFullscreen = useCallback(() => {
    const preview = previewRef.current
    if (!preview) return

    if (document.fullscreenElement === preview) {
      void document.exitFullscreen()
      return
    }

    void preview.requestFullscreen()
  }, [])

  const handleFullscreenWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isFullscreen || !event.ctrlKey) return

      event.preventDefault()
      const surface = videoSurfaceRef.current
      if (surface) {
        const rect = surface.getBoundingClientRect()
        const x = ((event.clientX - rect.left) / rect.width) * 100
        const y = ((event.clientY - rect.top) / rect.height) * 100
        setZoomOrigin(`${Math.min(100, Math.max(0, x))}% ${Math.min(100, Math.max(0, y))}%`)
      }

      const step = event.deltaY < 0 ? 25 : -25
      onZoomChange(Math.min(400, Math.max(25, zoom + step)))
    },
    [isFullscreen, onZoomChange, zoom],
  )

  const startToolDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawingTools.has(activeTool)) return
      const surface = videoSurfaceRef.current
      const type = annotationToolTypes[activeTool]
      if (!surface || !type) return

      event.preventDefault()
      event.stopPropagation()
      surface.setPointerCapture(event.pointerId)
      const point = pointFromEvent(event, surface)
      setDidDragTool(false)
      setDraft({
        type,
        start: point,
        end: point,
        points: type === "brush" || type === "pen" ? [point] : undefined,
      })
    },
    [activeTool],
  )

  const updateToolDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const surface = videoSurfaceRef.current
    if (!surface || !draft) return

    const point = pointFromEvent(event, surface)
    if (Math.abs(point.x - draft.start.x) > 0.004 || Math.abs(point.y - draft.start.y) > 0.004) {
      setDidDragTool(true)
    }
    setDraft((current) =>
      current
        ? {
            ...current,
            end: point,
            points:
              current.type === "brush" || current.type === "pen"
                ? [...(current.points ?? []), point]
                : current.points,
          }
        : current,
    )
  }, [draft])

  const finishToolDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const surface = videoSurfaceRef.current
      if (!surface || !draft) return

      event.preventDefault()
      event.stopPropagation()
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId)
      }

      const end = pointFromEvent(event, surface)
      const points =
        draft.type === "brush" || draft.type === "pen"
          ? [...(draft.points ?? []), end]
          : undefined
      const annotation = buildAnnotation(draft.type, draft.start, end, currentTime, duration, points)
      onCreateAnnotation(annotation)
      setDraft(null)
      setDidDragTool(true)
    },
    [currentTime, draft, duration, onCreateAnnotation],
  )

  const handleMoveStart = useCallback(
    (event: React.PointerEvent, annotation: Annotation) => {
      const surface = videoSurfaceRef.current
      if (!surface) return

      event.preventDefault()
      event.stopPropagation()
      onSelectAnnotation(annotation.id)

      const start = pointFromEvent(event, surface)
      const initial = { x: annotation.x, y: annotation.y }
      const move = (moveEvent: PointerEvent) => {
        const point = pointFromEvent(moveEvent, surface)
        onUpdateAnnotation(annotation.id, {
          x: Math.min(1 - annotation.width, Math.max(0, initial.x + point.x - start.x)),
          y: Math.min(1 - annotation.height, Math.max(0, initial.y + point.y - start.y)),
        })
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [onSelectAnnotation, onUpdateAnnotation],
  )

  const setPreviewVolume = useCallback(
    (value: number) => {
      const next = Math.min(100, Math.max(0, Math.round(value)))
      if (next > 0) lastAudibleVolumeRef.current = next
      onVolumeChange(next)
    },
    [onVolumeChange],
  )

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      lastAudibleVolumeRef.current = volume
      onVolumeChange(0)
      return
    }

    onVolumeChange(lastAudibleVolumeRef.current || 80)
  }, [onVolumeChange, volume])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === previewRef.current)
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.pause()
    video.removeAttribute("src")
    video.load()
    setIsSeekingMedia(false)
    setSeekError(null)
    if (playbackUrl) {
      video.src = playbackUrl
      video.load()
    }
  }, [playbackUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl || seekRevision === 0) return

    const target = Math.max(0, Math.min(currentTime, Number.isFinite(video.duration) ? video.duration : currentTime))
    let cancelled = false
    let timeout: number | null = null
    let recoveryAttempted = false

    const diagnostics = () => ({
      target,
      seekRevision,
      readyState: video.readyState,
      networkState: video.networkState,
      error: video.error?.message ?? null,
      buffered: Array.from({ length: video.buffered.length }, (_, index) => [
        video.buffered.start(index),
        video.buffered.end(index),
      ]),
      seekable: Array.from({ length: video.seekable.length }, (_, index) => [
        video.seekable.start(index),
        video.seekable.end(index),
      ]),
    })

    const finish = () => {
      if (cancelled) return
      if (timeout != null) window.clearTimeout(timeout)
      setIsSeekingMedia(false)
      setSeekError(null)
      if (isPlaying) void video.play().catch(() => undefined)
    }

    const armTimeout = () => {
      if (timeout != null) window.clearTimeout(timeout)
      timeout = window.setTimeout(() => {
        if (cancelled) return
        if (import.meta.env.DEV) console.warn("[media-seek:timeout]", diagnostics())
        if (!recoveryAttempted) {
          recoveryAttempted = true
          video.pause()
          video.removeAttribute("src")
          video.load()
          const separator = playbackUrl.includes("?") ? "&" : "?"
          video.src = `${playbackUrl}${separator}sourceGeneration=${seekRevision}`
          video.addEventListener("loadedmetadata", () => {
            if (cancelled) return
            video.currentTime = target
            armTimeout()
          }, { once: true })
          video.load()
          return
        }
        setIsSeekingMedia(false)
        setSeekError("Could not seek this media file. The container index or codec may be unsupported.")
      }, 8_000)
    }

    setIsSeekingMedia(true)
    setSeekError(null)
    video.addEventListener("seeked", finish)
    video.addEventListener("canplay", finish)
    video.currentTime = target
    armTimeout()
    if (import.meta.env.DEV) console.info("[media-seek:start]", diagnostics())
    return () => {
      cancelled = true
      if (timeout != null) window.clearTimeout(timeout)
      video.removeEventListener("seeked", finish)
      video.removeEventListener("canplay", finish)
    }
  // currentTime and isPlaying are sampled when the explicit seek revision changes;
  // ordinary timeupdate events must not restart this state machine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackUrl, seekRevision])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (isPlaying) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [isPlaying, playbackUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.volume = Math.max(0, Math.min(1, volume / 100))
  }, [volume])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.playbackRate = Number.parseFloat(playbackSpeed)
  }, [playbackSpeed])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return
    let cancelled = false
    let frameRequest: number | null = null
    let animationFrame: number | null = null

    const update = () => {
      if (cancelled) return
      playbackClock.set(video.currentTime)
      if ("requestVideoFrameCallback" in video) {
        frameRequest = video.requestVideoFrameCallback(update)
      } else {
        animationFrame = requestAnimationFrame(update)
      }
    }
    update()
    return () => {
      cancelled = true
      if (frameRequest != null && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(frameRequest)
      }
      if (animationFrame != null) cancelAnimationFrame(animationFrame)
    }
  }, [playbackUrl])

  useEffect(() => {
    if (!isPlaying) return
    const video = videoRef.current
    if (!video) return
    let longTaskCount = 0
    let longTaskDuration = 0
    const observer = typeof PerformanceObserver !== "undefined"
      ? new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) {
            longTaskCount += 1
            longTaskDuration += entry.duration
          }
        })
      : null
    try {
      observer?.observe({ entryTypes: ["longtask"] })
    } catch {
      observer?.disconnect()
    }
    const initial = video.getVideoPlaybackQuality?.()
    let lastTotalFrames = initial?.totalVideoFrames ?? 0
    let lastDroppedFrames = initial?.droppedVideoFrames ?? 0
    const startedAt = performance.now()
    let samples = 0
    const interval = window.setInterval(() => {
      const quality = video.getVideoPlaybackQuality?.()
      if (!quality) return
      const totalDelta = Math.max(0, quality.totalVideoFrames - lastTotalFrames)
      const droppedDelta = Math.max(0, quality.droppedVideoFrames - lastDroppedFrames)
      lastTotalFrames = quality.totalVideoFrames
      lastDroppedFrames = quality.droppedVideoFrames
      const droppedFrameRatio = totalDelta > 0 ? droppedDelta / totalDelta : 0
      onPerformanceMetrics?.({
        droppedFrameRatio,
        userActive: false,
        windowVisible: document.visibilityState === "visible",
      })
      samples += 1
      if (import.meta.env.DEV && samples % 5 === 0) {
        console.info("[media-profile]", {
          elapsedSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
          decodedFrames: quality.totalVideoFrames - (initial?.totalVideoFrames ?? 0),
          droppedFrames: quality.droppedVideoFrames - (initial?.droppedVideoFrames ?? 0),
          droppedFrameRatio,
          longTasks: longTaskCount,
          longTaskMilliseconds: Math.round(longTaskDuration),
        })
      }
    }, 1000)
    return () => {
      window.clearInterval(interval)
      observer?.disconnect()
    }
  }, [isPlaying, onPerformanceMetrics, playbackUrl])

  return (
    <div
      ref={previewRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-background",
        isFullscreen && "h-screen w-screen",
      )}
    >
      {/* Info header */}
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-border px-4 text-xs">
        <span className="font-medium text-foreground">{videoInfo.filename}</span>
        {hasMedia && (
          <>
            <span className="text-muted-foreground">{videoInfo.resolution}</span>
            <span className="text-muted-foreground">{videoInfo.fps} fps</span>
          </>
        )}
        <span className="ml-auto font-mono tabular-nums text-muted-foreground">
          {formatTimecode(currentTime, videoInfo.fps)}
        </span>
        {hasMedia && (
          <span className="rounded-md bg-secondary/60 px-1.5 py-0.5 font-mono text-muted-foreground">
            {zoom}%
          </span>
        )}
      </div>

      {!hasMedia ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-xl flex-col items-center rounded-xl border border-dashed border-border bg-card/35 px-8 py-10 text-center">
            <div className="mb-5 flex size-14 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/20">
              <FileVideo className="size-7" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Choose a video file</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              Open a local video to enable preview, trimming, timeline tracks, media details, and export.
            </p>
            <button
              type="button"
              onClick={onOpenVideo}
              disabled={isLoading}
              className="mt-6 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
            >
              <FolderOpen className="size-4" />
              {isLoading ? "Opening..." : "Open video"}
            </button>
          </div>
        </div>
      ) : (
        <>
      {/* Video canvas */}
      <div
        className={cn("flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6", isFullscreen && "p-4")}
        onWheel={handleFullscreenWheel}
      >
        <div
          ref={videoSurfaceRef}
          role="button"
          tabIndex={0}
          onPointerDown={startToolDrag}
          onPointerMove={updateToolDrag}
          onPointerUp={finishToolDrag}
          onPointerCancel={() => setDraft(null)}
          onClick={() => {
            if (didDragTool || drawingTools.has(activeTool)) {
              setDidDragTool(false)
              return
            }
            onSelectAnnotation(null)
            if (activeTool === "select") onTogglePlay()
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onSelectAnnotation(null)
            if (e.code === "Space" || e.key === "Enter") {
              e.preventDefault()
              onTogglePlay()
            }
          }}
          className={cn(
            "group relative aspect-video max-h-full w-full cursor-default overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-border",
            isFullscreen ? "max-w-none rounded-none" : "max-w-5xl",
          )}
          style={{
            transform: `scale(${Math.min(isFullscreen ? 4 : 1.4, zoom / 100)})`,
            transformOrigin: isFullscreen ? zoomOrigin : "50% 50%",
          }}
          aria-label="Video preview"
        >
          {playbackUrl && (
            <video
              ref={videoRef}
              className="absolute inset-0 size-full object-contain"
              preload="auto"
              onLoadedMetadata={(event) =>
                onLoadedMetadata({
                  duration: event.currentTarget.duration,
                  resolution: `${event.currentTarget.videoWidth} x ${event.currentTarget.videoHeight}`,
                })
              }
              onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
              onSeeking={() => setIsSeekingMedia(true)}
              onSeeked={() => setIsSeekingMedia(false)}
              onError={(event) => {
                const message = event.currentTarget.error?.message
                if (message) setSeekError(message)
              }}
              onEnded={onEnded}
            />
          )}
          {/* overlays */}
          <div className="pointer-events-none absolute inset-0">
            <div className="pointer-events-auto absolute inset-0">
              {visibleAnnotations.map((a) => (
                <AnnotationOverlay
                  key={a.id}
                  a={a}
                  selected={a.id === selectedId}
                  activeTool={activeTool}
                  onClick={() => onSelectAnnotation(a.id)}
                  onMoveStart={handleMoveStart}
                />
              ))}
            </div>
          </div>
          {draft && <DraftOverlay draft={draft} />}
          {isSeekingMedia && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
              Seeking…
            </div>
          )}
          {seekError && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-center text-xs text-destructive-foreground">
              {seekError}
            </div>
          )}
          {/* center play affordance */}
          {!isPlaying && playbackUrl && (
            <span className="pointer-events-none absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/40 backdrop-blur-sm transition-opacity group-hover:opacity-100">
              <Play className="size-7 translate-x-0.5 text-foreground" />
            </span>
          )}
        </div>
      </div>

      {/* Scrubber */}
      <div className="px-4 pb-1 pt-2">
        <Slider
          value={[currentTime]}
          min={0}
          max={duration}
          step={frame}
          onValueChange={(v) => onSeek(Array.isArray(v) ? v[0] : v)}
          aria-label="Playback position"
        />
      </div>

      {/* Playback controls */}
      <div className="flex h-16 items-center gap-2 px-4">
        <div className="flex flex-1 items-center gap-1">
          <ControlButton label="Skip back 30s" onClick={() => onSeek(Math.max(0, currentTime - 30))}>
            <ChevronsLeft className="size-4" />
          </ControlButton>
          <ControlButton label="Back 5s" onClick={() => onSeek(Math.max(0, currentTime - 5))}>
            <Rewind className="size-4" />
          </ControlButton>
          <ControlButton label="Previous frame" onClick={() => onSeek(Math.max(0, currentTime - frame))}>
            <SkipBack className="size-4" />
          </ControlButton>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex flex-col items-center">
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {formatTimecode(currentTime, videoInfo.fps)}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {playbackSpeed}x  ·  {formatTimecode(duration, videoInfo.fps)}
            </span>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-1">
          <ControlButton label="Next frame" onClick={() => onSeek(Math.min(duration, currentTime + frame))}>
            <SkipForward className="size-4" />
          </ControlButton>
          <ControlButton label="Forward 5s" onClick={() => onSeek(Math.min(duration, currentTime + 5))}>
            <FastForward className="size-4" />
          </ControlButton>
          <ControlButton label="Skip forward 30s" onClick={() => onSeek(Math.min(duration, currentTime + 30))}>
            <ChevronsRight className="size-4" />
          </ControlButton>

          <div className="mx-2 flex w-40 items-center gap-2 rounded-lg bg-secondary/40 px-2 py-1">
            <button
              type="button"
              onClick={toggleMute}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={volume > 0 ? "Mute video" : "Unmute video"}
            >
              {volume > 0 ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
            <Slider
              value={[volume]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setPreviewVolume(Array.isArray(v) ? v[0] : v)}
              className="min-w-0 flex-1"
              aria-label="Volume"
            />
            <span className="w-8 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {Math.round(volume)}
            </span>
          </div>

          <div className="mx-1 flex items-center gap-1.5">
            <Gauge className="size-4 text-muted-foreground" />
            <select
              value={playbackSpeed}
              onChange={(event) => onPlaybackSpeedChange(event.currentTarget.value)}
              className="h-8 w-[76px] rounded-lg border border-transparent bg-secondary/60 px-2 text-sm text-foreground outline-none transition-colors hover:bg-secondary/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Playback speed"
            >
              {SPEEDS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </div>

          <ControlButton label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </ControlButton>
        </div>
      </div>
        </>
      )}
    </div>
  )
}
