"use client"

import { memo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
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
import type { Annotation, AnnotationType, TimelineClip, ToolId, VideoInfo } from "@/lib/editor-types"
import { clipAt, sourceStart, sourceTime, editTime } from "@/lib/timeline-edit"
import { ANNOTATION_NAMES, formatTimecode } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { playbackClock } from "@/stores/playback-clock"
import { PreviewSeekQueue } from "@/lib/preview-seek-queue"
import type { PlaybackCopyState } from "@/hooks/use-playback-proxy"
import type { FrameStep, RuntimeMetrics, SeekMode } from "@/types/media"
import { FrameStepQueue } from "@/lib/frame-step-queue"
import { getMediaService } from "@/services/media-service-provider"
import { toMediaServiceError } from "@/services/media-service"

const SPEEDS = ["0.25", "0.5", "1", "1.5", "2"]

interface PreviewProps {
  clips: TimelineClip[]
  frameSourcePath: string | null
  mediaSession: number
  seekFrameTime: number | null
  playbackCopy: PlaybackCopyState
  playbackCopyProgress: number
  onPreparePlayback: () => void
  onPlaybackError: () => void
  onCancelPlaybackCopy: () => void
  onTogglePlaybackCopy: () => void
  videoInfo: VideoInfo
  playbackUrl: string | null
  currentTime: number
  seekRevision: number
  seekTarget: number
  seekMode: SeekMode
  duration: number
  isPlaying: boolean
  onTogglePlay: () => void
  onEnded: () => void
  onSeek: (t: number, mode?: SeekMode, frameTime?: number) => void
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
  onEditStart: () => void
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void
  onOpenVideo: () => void
  hasMedia: boolean
  isLoading: boolean
  onPerformanceMetrics?: (metrics: RuntimeMetrics) => void
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

function codecContentType(codec: string) {
  const normalized = codec.toLowerCase()
  if (normalized.includes("hevc") || normalized.includes("h.265")) return 'video/mp4; codecs="hvc1.1.6.L93.B0"'
  if (normalized.includes("av1")) return 'video/mp4; codecs="av01.0.05M.08"'
  if (normalized.includes("vp9")) return 'video/webm; codecs="vp09.00.10.08"'
  if (normalized.includes("h.264") || normalized.includes("avc")) return 'video/mp4; codecs="avc1.42E01E"'
  return null
}

async function detectPowerEfficientDecode(
  codec: string,
  resolutionText: string,
  bitrateText: string,
  fps: number,
  fpsKnown: boolean,
) {
  const contentType = codecContentType(codec)
  if (!contentType || !navigator.mediaCapabilities?.decodingInfo) return undefined
  const resolution = resolutionText.match(/(\d+)\s*x\s*(\d+)/i)
  const bitrateValue = Number.parseFloat(bitrateText.replace(",", "."))
  const bitrateMultiplier = /gbps/i.test(bitrateText)
    ? 1_000_000_000
    : /mbps/i.test(bitrateText)
      ? 1_000_000
      : /kbps/i.test(bitrateText)
        ? 1_000
        : 1
  try {
    const result = await navigator.mediaCapabilities.decodingInfo({
      type: "file",
      video: {
        contentType,
        width: Number(resolution?.[1] ?? 1920),
        height: Number(resolution?.[2] ?? 1080),
        bitrate: Number.isFinite(bitrateValue) ? Math.round(bitrateValue * bitrateMultiplier) : 8_000_000,
        framerate: fpsKnown ? fps : 30,
      },
    })
    return result.supported && result.smooth && result.powerEfficient
  } catch {
    return undefined
  }
}

function annotationBox(start: NormalizedPoint, end: NormalizedPoint) {
  const x = Math.min(0.985, start.x, end.x)
  const y = Math.min(0.985, start.y, end.y)
  const width = Math.max(0.015, Math.abs(end.x - start.x))
  const height = Math.max(0.015, Math.abs(end.y - start.y))
  return { x, y, width, height }
}

function pointsBox(points: NormalizedPoint[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(0.985, ...xs)
  const y = Math.min(0.985, ...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const width = Math.max(0.015, maxX - x)
  const height = Math.max(0.015, maxY - y)
  return { x, y, width, height }
}

function normalizePathPoints(points: NormalizedPoint[], box: { x: number; y: number; width: number; height: number }) {
  return points.map((point) => ({
    x: Math.min(1, Math.max(0, (point.x - box.x) / box.width)),
    y: Math.min(1, Math.max(0, (point.y - box.y) / box.height)),
  }))
}

function lineGeometry(start: NormalizedPoint, end: NormalizedPoint) {
  const box = annotationBox(start, end)
  return {
    lineStartX: Math.min(1, Math.max(0, (start.x - box.x) / box.width)),
    lineStartY: Math.min(1, Math.max(0, (start.y - box.y) / box.height)),
    lineEndX: Math.min(1, Math.max(0, (end.x - box.x) / box.width)),
    lineEndY: Math.min(1, Math.max(0, (end.y - box.y) / box.height)),
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
    id: crypto.randomUUID(),
    type,
    label: ANNOTATION_NAMES[type],
    color: style.color,
    opacity: style.opacity,
    thickness: style.thickness,
    font: "Inter",
    visible: true,
    startTime: type === "crop" ? 0 : Math.min(currentTime, Math.max(0, duration - 0.001)),
    endTime: type === "crop" ? duration : Math.min(duration, Math.max(currentTime + 0.25, visibleEnd)),
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

const AnnotationOverlay = memo(function AnnotationOverlay({
  a,
  selected,
  activeTool,
  onSelect,
  onMoveStart,
  unitScale,
}: {
  a: Annotation
  selected: boolean
  activeTool: ToolId
  onSelect: (id: string) => void
  onMoveStart: (event: React.PointerEvent, annotation: Annotation) => void
  unitScale: number
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    left: `${a.x * 100}%`,
    top: `${a.y * 100}%`,
    width: `${a.width * 100}%`,
    height: `${a.height * 100}%`,
    opacity: a.opacity / 100,
    pointerEvents: drawingTools.has(activeTool) ? "none" : "auto",
    outline: selected ? "1px dashed var(--color-primary)" : undefined,
  }
  const ring = selected ? "0 0 0 2px var(--color-primary)" : "none"
  const points = linePoints(a)

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        if (activeTool === "move" || activeTool === "select") {
          onMoveStart(event, a)
        }
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(a.id)
      }}
      style={base}
      className="group/annotation cursor-pointer"
      aria-label={a.label}
    >
      {a.type === "rectangle" && (
        <div
          className="size-full rounded-sm"
          style={{ border: `${a.thickness * unitScale}px solid ${a.color}`, boxShadow: ring }}
        />
      )}
      {a.type === "circle" && (
        <div
          className="size-full rounded-full"
          style={{ border: `${a.thickness * unitScale}px solid ${a.color}`, boxShadow: ring }}
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
            border: selected ? `1px dashed ${a.color}` : undefined,
            boxShadow: ring,
            backdropFilter: `blur(${Math.max(4, a.thickness * 2) * unitScale}px)`,
            WebkitBackdropFilter: `blur(${Math.max(4, a.thickness * 2) * unitScale}px)`,

          }}
        />
      )}
      {a.type === "crop" && (
        <div
          className="size-full rounded-sm bg-black/5"
          style={{ border: `1px dashed ${a.color}`, boxShadow: "0 0 0 9999px rgb(0 0 0 / 65%)" }}
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
            strokeWidth={a.thickness * unitScale}
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
            strokeWidth={a.thickness * unitScale}
            strokeLinecap="round"
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x="50%"
            y="45%"
            textAnchor="middle"
            fill={a.color}
            fontSize={22 * unitScale}
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
          style={{ color: a.color, fontSize: `${Math.max(10, a.thickness + 6) * unitScale}px`, fontFamily: a.font, fontWeight: 400, textShadow: `0 0 ${2 * unitScale}px black`, boxShadow: ring }}
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
            strokeWidth={a.thickness * unitScale}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </button>
  )
})

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
  clips,
  frameSourcePath,
  mediaSession,
  seekFrameTime: timelineFrameTime,
  playbackCopy,
  playbackCopyProgress,
  onPreparePlayback,
  onPlaybackError,
  onCancelPlaybackCopy,
  onTogglePlaybackCopy,
  videoInfo,
  playbackUrl,
  currentTime,
  seekRevision,
  seekTarget: timelineSeekTarget,
  seekMode,
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
  onEditStart,
  onUpdateAnnotation,
  onOpenVideo,
  hasMedia,
  isLoading,
  onPerformanceMetrics,
}: PreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const activeClipRef = useRef<TimelineClip | null>(null)
  const requestedClip = clipAt(clips, timelineSeekTarget) ?? (timelineSeekTarget >= duration ? clips.at(-1) : undefined)
  const showGap = !requestedClip
  const seekTarget = requestedClip ? Math.max(0, sourceTime(requestedClip, Math.min(timelineSeekTarget, requestedClip.endTime - 0.000001))) : 0
  const seekFrameTime = requestedClip && timelineFrameTime !== null ? sourceTime(requestedClip, timelineFrameTime) : null
  const previewSeeksRef = useRef(new PreviewSeekQueue())
  const frameStepsRef = useRef<FrameStepQueue | null>(null)
  const pausedFrameTimeRef = useRef<number | null>(null)
  const presentedFrameRef = useRef<number | null>(null)
  const [isReadingFrames, setIsReadingFrames] = useState(false)
  const mediaService = getMediaService()
  const hardwareDecodeAvailableRef = useRef<boolean | undefined>(undefined)
  const lastAudibleVolumeRef = useRef(80)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [zoomOrigin, setZoomOrigin] = useState("50% 50%")
  const [draft, setDraft] = useState<DraftAnnotation | null>(null)
  const [didDragTool, setDidDragTool] = useState(false)
  const [isSeekingMedia, setIsSeekingMedia] = useState(false)
  const [seekError, setSeekError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [surfaceSize, setSurfaceSize] = useState({width: 960, height: 540})
  const [mediaAspect, setMediaAspect] = useState(16 / 9)
  const frame = 1 / videoInfo.fps
  const publishFrameStep = useEffectEvent((step: FrameStep) => {
    const clip = step.editClipId ? clips.find(c => c.id === step.editClipId) : activeClipRef.current
    if (!clip) return
    activeClipRef.current = clip
    pausedFrameTimeRef.current = step.time
    onSeek(editTime(clip, step.seekTime), "frame", editTime(clip, step.time))
  })
  const readFrame = useEffectEvent(async (time: number, direction: -1 | 1): Promise<FrameStep> => {
    const clip = activeClipRef.current
    if (!frameSourcePath || !clip) throw new Error("Выберите клип для покадрового перехода.")
    const step = await mediaService.getFrameStep(frameSourcePath, time, direction)
    const sourceEnd = sourceStart(clip) + clip.endTime - clip.startTime
    if (step.time >= sourceStart(clip) && step.time < sourceEnd && (!step.atBoundary || !clips[clips.findIndex(c => c.id === clip.id) + direction])) return step
    const adjacent = clips[clips.findIndex(c => c.id === clip.id) + direction]
    const lastFrameBefore = async (end: number) => {
      const previous = await mediaService.getFrameStep(frameSourcePath, end, -1)
      const containing = await mediaService.getFrameStep(frameSourcePath, previous.time, 1)
      return containing.time < end ? containing : previous
    }
    if (!adjacent) return direction > 0 ? lastFrameBefore(sourceEnd) : mediaService.getFrameStep(frameSourcePath, Math.max(0, sourceStart(clip) - 0.000003), sourceStart(clip) === 0 ? -1 : 1)
    const boundary = sourceStart(adjacent) + (direction > 0 ? -0.000003 : adjacent.endTime - adjacent.startTime)
    const adjacentFrame = direction < 0 ? await lastFrameBefore(boundary) : await mediaService.getFrameStep(frameSourcePath, Math.max(0, boundary), boundary < 0 ? -1 : 1)
    return { ...adjacentFrame, editClipId: adjacent.id }
  })
  useEffect(() => {
    if (!frameSourcePath || !playbackUrl) return
    const queue = new FrameStepQueue({
      currentTime: () => Math.max(0, presentedFrameRef.current ?? videoRef.current?.currentTime ?? 0),
      read: (time, direction) => readFrame(time, direction),
      publish: step => publishFrameStep(step),
      cancelRead: () => mediaService.cancelFrameSteps(),
      busy: setIsReadingFrames,
      error: error => { const details = toMediaServiceError(error); setSeekError(details.technicalDetails || details.message) },
    })
    frameStepsRef.current = queue
    return () => { queue.cancel(); frameStepsRef.current = null }
  }, [frameSourcePath, mediaService, playbackUrl, mediaSession])
  useEffect(() => {
    if (isPlaying) {
      pausedFrameTimeRef.current = null
      frameStepsRef.current?.cancel()
    }
  }, [isPlaying])

  const requestFrameStep = useCallback((direction: -1 | 1) => {
    const video = videoRef.current
    if (!video || videoInfo.hasVideo === false) return
    video.pause()
    onEnded()
    setSeekError(null)
    previewSeeksRef.current.clear()
    void mediaService.cancelBackgroundMedia(false).catch(() => undefined)
    frameStepsRef.current?.request(direction)
  }, [mediaService, onEnded, videoInfo.hasVideo])
  useEffect(() => {
    const stepKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || target?.closest("input,textarea,select,[contenteditable=true],[role=dialog],[role=alertdialog]")) return
      if (event.key !== "," && event.key !== ".") return
      event.preventDefault()
      requestFrameStep(event.key === "," ? -1 : 1)
    }
    window.addEventListener("keydown", stepKey)
    return () => window.removeEventListener("keydown", stepKey)
  }, [requestFrameStep])
  const reportPlaybackFailure = useEffectEvent((source: string, error: unknown) => {
    if (!isPlaying || videoRef.current?.src !== source) return
    if (error instanceof DOMException && error.name === "AbortError") return
    setSeekError(error instanceof Error ? error.message : "Could not play this media file.")
    onEnded()
  })
  const applyPlaybackIntent = useEffectEvent(() => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = Number(playbackSpeed)
    video.volume = Math.max(0, Math.min(1, volume / 100))
    if (!isPlaying) { video.pause(); return }
    if (!clips.length) { video.pause(); onEnded(); return }
    if (!activeClipRef.current) { video.pause(); return }
    if (playbackClock.getSnapshot() >= duration - 0.000001) { onSeek(0, "precise"); return }
    const source = video.src
    void video.play().catch(error => reportPlaybackFailure(source, error))
  })
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const resize = () => {
      const style = getComputedStyle(container)
      const width = Math.max(1, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
      const height = Math.max(1, container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
      const fitWidth = Math.min(width, height * mediaAspect, isFullscreen ? Infinity : 1024)
      setSurfaceSize({width: fitWidth, height: fitWidth / mediaAspect})
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    return () => observer.disconnect()
  }, [hasMedia, isFullscreen, mediaAspect])
  const visibleAnnotations = annotations.filter(
    (a) => a.visible && currentTime >= a.startTime && currentTime < a.endTime,
  )
  const selectedAnnotation = visibleAnnotations.find(a => a.id === selectedId)

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
      if (event.button !== 0 || videoInfo.hasVideo === false || !drawingTools.has(activeTool)) return
      const surface = videoSurfaceRef.current
      const type = annotationToolTypes[activeTool]
      if (!surface || !type) return

      event.preventDefault()
      event.stopPropagation()
      if (isPlaying) onTogglePlay()
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
    [activeTool, isPlaying, onTogglePlay, videoInfo.hasVideo],
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
      if (event.button !== 0 || !surface) return

      event.preventDefault()
      event.stopPropagation()
      onEditStart()
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
        window.removeEventListener("pointercancel", up)
        window.removeEventListener("blur", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", up)
      window.addEventListener("blur", up)
    },
    [onEditStart, onSelectAnnotation, onUpdateAnnotation],
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
    previewSeeksRef.current.clear()
    presentedFrameRef.current = null
    pausedFrameTimeRef.current = null
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
    activeClipRef.current = requestedClip ?? null
    if (!requestedClip) { video.pause(); previewSeeksRef.current.clear(); frameStepsRef.current?.cancel(); return }
    if (seekMode !== "frame") {
      pausedFrameTimeRef.current = null
      frameStepsRef.current?.cancel()
    }

    const requestedTarget = Math.max(0, seekTarget)
    const fastSeek = (video as HTMLVideoElement & { fastSeek?: (time: number) => void }).fastSeek
    if (seekMode === "preview") {
      const queue = previewSeeksRef.current
      const apply = (time: number) => {
        const target = Math.min(time, Number.isFinite(video.duration) ? video.duration : time)
        if (typeof fastSeek === "function") fastSeek.call(video, target)
        else video.currentTime = target
      }
      const flush = () => { if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_METADATA) queue.flush(apply) }
      video.addEventListener("seeked", flush)
      video.addEventListener("loadedmetadata", flush)
      queue.request(requestedTarget, video.seeking || video.readyState < HTMLMediaElement.HAVE_METADATA, apply)
      return () => {
        video.removeEventListener("seeked", flush)
        video.removeEventListener("loadedmetadata", flush)
      }
    }
    previewSeeksRef.current.clear()

    let cancelled = false
    let timeout: number | null = null
    let beginFrame: number | null = null
    let recoveryAttempted = false
    let waitingForMetadata = false
    let frameCallback: number | null = null
    const expectedFrame = seekMode === "frame" ? seekFrameTime : null
    const canObserveFrame = typeof video.requestVideoFrameCallback === "function"
    let shownFrame = presentedFrameRef.current
    const frameMatches = () => expectedFrame !== null && shownFrame !== null && Math.abs(shownFrame - expectedFrame) <= 0.000002

    const diagnostics = () => ({
      target: requestedTarget,
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
      if (beginFrame != null) {
        cancelAnimationFrame(beginFrame)
        beginFrame = null
      }
      setIsSeekingMedia(false)
      setSeekError(null)
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback)
      if (expectedFrame !== null) onTimeUpdate(editTime(requestedClip, expectedFrame))
      applyPlaybackIntent()
    }

    const seek = () => {
      if (cancelled) return
      waitingForMetadata = false
      const target = Math.max(
        0,
        Math.min(requestedTarget, Number.isFinite(video.duration) ? video.duration : requestedTarget),
      )
      if (!video.seeking && (expectedFrame !== null ? frameMatches() : Math.abs(video.currentTime - target) < 0.001)) {
        finish()
        return
      }
      video.currentTime = target
      armTimeout()
    }

    const waitForMetadataOrSeek = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        seek()
        return
      }
      waitingForMetadata = true
      video.addEventListener("loadedmetadata", seek, { once: true })
      armTimeout()
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
          waitingForMetadata = true
          video.addEventListener("loadedmetadata", seek, { once: true })
          video.load()
          armTimeout()
          return
        }
        cancelled = true
        frameStepsRef.current?.cancel()
        video.removeEventListener("loadedmetadata", seek)
        video.removeEventListener("seeked", seekFinished)
        video.pause()
        onEnded()
        setIsSeekingMedia(false)
        setSeekError("Could not seek this media file. The container index or codec may be unsupported.")
      }, 8_000)
    }

    beginFrame = requestAnimationFrame(() => {
      if (cancelled) return
      setIsSeekingMedia(true)
      setSeekError(null)
    })
    const seekFinished = () => {
      if (video.seeking) return
      if (expectedFrame !== null && canObserveFrame) { if (frameMatches()) finish() }
      else if (Math.abs(video.currentTime - Math.min(requestedTarget, video.duration)) < Math.max(frame, 0.05)) finish()
    }
    if (expectedFrame !== null && canObserveFrame) {
      const observe: VideoFrameRequestCallback = (_now, metadata) => {
        if (cancelled) return
        shownFrame = metadata.mediaTime
        if (frameMatches() && !video.seeking) finish()
        else frameCallback = video.requestVideoFrameCallback(observe)
      }
      frameCallback = video.requestVideoFrameCallback(observe)
    }
    video.addEventListener("seeked", seekFinished)
    waitForMetadataOrSeek()
    if (import.meta.env.DEV) console.info("[media-seek:start]", diagnostics())
    return () => {
      cancelled = true
      if (beginFrame != null) cancelAnimationFrame(beginFrame)
      if (timeout != null) window.clearTimeout(timeout)
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback)
      if (waitingForMetadata) video.removeEventListener("loadedmetadata", seek)
      video.removeEventListener("seeked", seekFinished)
    }
  // The target is independent of media timeupdate events;
  // ordinary timeupdate events must not restart this state machine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackUrl, seekMode, seekRevision, seekTarget, seekFrameTime, clips, timelineSeekTarget])

  const publishFrameTime = useEffectEvent((time: number) => {
    presentedFrameRef.current = time
    const clip = activeClipRef.current
    const video = videoRef.current
    if (!clip || !video || video.seeking || showGap || !isPlaying) return
    const mapped = Math.max(clip.startTime, editTime(clip, time))
    if (isPlaying && mapped >= clip.endTime - 0.000001) {
      video.pause()
      const next = clips[clips.findIndex(c => c.id === clip.id) + 1]
      if (next) onSeek(clip.endTime, "precise")
      else { playbackClock.set(duration); onTimeUpdate(duration); onEnded() }
      return
    }
    if (seekMode !== "preview") playbackClock.set(Math.min(clip.endTime, mapped))
  })

  const mediaEnded = useEffectEvent(() => {
    const clip = activeClipRef.current
    const next = clip && clips[clips.findIndex(c => c.id === clip.id) + 1]
    if (isPlaying && clip && next) onSeek(clip.endTime, "precise")
    else { playbackClock.set(duration); onTimeUpdate(duration); onEnded() }
  })

  const mediaTimeUpdate = useEffectEvent(() => {
    const video = videoRef.current
    const clip = activeClipRef.current
    if (!video || !clip || video.seeking || showGap || seekMode === "preview") return
    const source = !isPlaying ? pausedFrameTimeRef.current ?? video.currentTime : video.currentTime
    publishFrameTime(source)
    onTimeUpdate(Math.max(clip.startTime, Math.min(clip.endTime, editTime(clip, source))))
  })
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.addEventListener("timeupdate", mediaTimeUpdate)
    video.addEventListener("ended", mediaEnded)
    return () => {
      video.removeEventListener("timeupdate", mediaTimeUpdate)
      video.removeEventListener("ended", mediaEnded)
    }
  }, [playbackUrl])

  const advanceGap = useEffectEvent((time: number, end: number) => {
    playbackClock.set(time)
    onTimeUpdate(time)
    if (time >= end) { if (end < duration) onSeek(end, "precise"); else onEnded() }
  })

  useEffect(() => {
    if (!showGap || !isPlaying) return
    const start = playbackClock.getSnapshot()
    const end = clips.find(clip => clip.startTime > start)?.startTime ?? duration
    const started = performance.now()
    let frame = 0
    const tick = () => {
      const time = Math.min(end, start + (performance.now() - started) / 1000 * Number(playbackSpeed))
      advanceGap(time, end)
      if (time >= end) return
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [showGap, isPlaying, playbackSpeed, clips, duration, timelineSeekTarget])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    applyPlaybackIntent()
    video.addEventListener("loadedmetadata", applyPlaybackIntent)
    return () => video.removeEventListener("loadedmetadata", applyPlaybackIntent)
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
  }, [playbackSpeed, playbackUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return
    let cancelled = false
    let frameRequest: number | null = null
    let animationFrame: number | null = null

    const update: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled) return
      publishFrameTime(metadata.mediaTime)
      frameRequest = video.requestVideoFrameCallback(update)
    }
    const fallback = () => {
      if (cancelled) return
      publishFrameTime(video.currentTime)
      if (isPlaying) animationFrame = requestAnimationFrame(fallback)
    }
    if (typeof video.requestVideoFrameCallback === "function" && videoInfo.hasVideo !== false) frameRequest = video.requestVideoFrameCallback(update)
    else fallback()
    return () => {
      cancelled = true
      if (frameRequest != null && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(frameRequest)
      }
      if (animationFrame != null) cancelAnimationFrame(animationFrame)
    }
  }, [isPlaying, playbackUrl, videoInfo.hasVideo])

  useEffect(() => {
    let cancelled = false
    hardwareDecodeAvailableRef.current = undefined
    void detectPowerEfficientDecode(
      videoInfo.codec,
      videoInfo.resolution,
      videoInfo.bitrate,
      videoInfo.fps,
      videoInfo.fpsKnown,
    ).then((available) => {
      if (cancelled) return
      hardwareDecodeAvailableRef.current = available
      if (available !== undefined) {
        onPerformanceMetrics?.({
          droppedFrameRatio: 0,
          userActive: false,
          windowVisible: document.visibilityState === "visible",
          hardwareDecodeAvailable: available,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    onPerformanceMetrics,
    videoInfo.bitrate,
    videoInfo.codec,
    videoInfo.fps,
    videoInfo.fpsKnown,
    videoInfo.resolution,
  ])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return
    let longTaskCount = 0
    let longTaskDuration = 0
    let lastLongTaskDuration = 0
    let lastMetricsAt = performance.now()
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
    const frameSamples: Array<{ total: number; dropped: number }> = []
    const startedAt = performance.now()
    let samples = 0
    const interval = window.setInterval(() => {
      const quality = video.getVideoPlaybackQuality?.()
      const totalDelta = Math.max(0, (quality?.totalVideoFrames ?? 0) - lastTotalFrames)
      const droppedDelta = Math.max(0, (quality?.droppedVideoFrames ?? 0) - lastDroppedFrames)
      lastTotalFrames = quality?.totalVideoFrames ?? 0
      lastDroppedFrames = quality?.droppedVideoFrames ?? 0
      frameSamples.push({ total: totalDelta, dropped: droppedDelta })
      if (frameSamples.length > 5) frameSamples.shift()
      const rollingFrames = frameSamples.reduce((sum, sample) => sum + sample.total, 0)
      const rollingDropped = frameSamples.reduce((sum, sample) => sum + sample.dropped, 0)
      const droppedFrameRatio = isPlaying && !video.seeking && rollingFrames > 0 ? rollingDropped / rollingFrames : 0
      const now = performance.now()
      const uiLongTaskRatio = Math.min(1, (longTaskDuration - lastLongTaskDuration) / Math.max(1, now - lastMetricsAt))
      lastMetricsAt = now
      lastLongTaskDuration = longTaskDuration
      onPerformanceMetrics?.({
        uiLongTaskRatio,
        droppedFrameRatio,
        userActive: false,
        windowVisible: document.visibilityState === "visible",
        hardwareDecodeAvailable: hardwareDecodeAvailableRef.current,
      })
      samples += 1
      if (import.meta.env.DEV && samples % 5 === 0) {
        console.info("[media-profile]", {
          elapsedSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
          decodedFrames: (quality?.totalVideoFrames ?? 0) - (initial?.totalVideoFrames ?? 0),
          droppedFrames: (quality?.droppedVideoFrames ?? 0) - (initial?.droppedVideoFrames ?? 0),
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
        {hasMedia && videoInfo.hasVideo !== false && (
          <>
            <span className="text-muted-foreground">{videoInfo.resolution}</span>
            <span className="text-muted-foreground">{Number(videoInfo.fps.toFixed(3))} fps{videoInfo.variableFps ? " (variable)" : ""}</span>
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

      {hasMedia && videoInfo.hasVideo !== false && (
        <div className="flex min-h-8 shrink-0 items-center gap-3 border-b border-border px-4 py-1 text-xs">
          {playbackCopy.status === "preparing" ? <>
            <span role="status">Preparing smoother playback: {Math.round(playbackCopyProgress * 100)}%</span>
            <button className="text-muted-foreground hover:text-foreground" onClick={onCancelPlaybackCopy}>Cancel</button>
          </> : playbackCopy.path ? <>
            <span>{playbackCopy.active ? "Optimized preview" : "Original preview"}</span>
            <button disabled={playbackCopy.status === "switching"} className="text-primary disabled:opacity-50" onClick={onTogglePlaybackCopy}>
              {playbackCopy.status === "switching" ? "Switching…" : playbackCopy.active ? "Use original" : "Use optimized copy"}
            </button>
          </> : <button className="text-primary" onClick={onPreparePlayback}>
            {playbackCopy.status === "error" ? "Retry playback optimization" : "Optimize playback"}
          </button>}
          {playbackCopy.error && <span role="alert" className="text-destructive">{playbackCopy.error}</span>}
        </div>
      )}

      {!hasMedia ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-xl flex-col items-center rounded-xl border border-dashed border-border bg-card/35 px-8 py-10 text-center">
            <div className="mb-5 flex size-14 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/20">
              <FileVideo className="size-7" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Choose a video or audio file</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              Open local video or audio to preview, trim, edit and export clips.
            </p>
            <button
              type="button"
              onClick={onOpenVideo}
              disabled={isLoading}
              className="mt-6 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
            >
              <FolderOpen className="size-4" />
              {isLoading ? "Opening..." : "Open media"}
            </button>
          </div>
        </div>
      ) : (
        <>
      {/* Video canvas */}
      <div
        ref={containerRef}
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
            "group relative shrink-0 cursor-default overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-border",
            isFullscreen ? "max-w-none rounded-none" : "max-w-5xl",
          )}
          style={{
            width: surfaceSize.width,
            height: surfaceSize.height,
            transform: `scale(${Math.min(isFullscreen ? 4 : 1.4, zoom / 100)})`,
            transformOrigin: isFullscreen ? zoomOrigin : "50% 50%",
          }}
          aria-label="Video preview"
        >
          {playbackUrl && (
            <video
              ref={videoRef}
              className={cn("absolute inset-0 size-full object-contain", showGap && "invisible")}
              preload="metadata"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget
                video.playbackRate = Number(playbackSpeed)
                if (video.videoWidth && video.videoHeight) setMediaAspect(video.videoWidth / video.videoHeight)
                onLoadedMetadata({
                  duration: event.currentTarget.duration,
                  resolution: `${event.currentTarget.videoWidth} x ${event.currentTarget.videoHeight}`,
                })
              }}
              onSeeking={() => { presentedFrameRef.current = null; setSeekError(null); setIsSeekingMedia(true) }}
              onSeeked={() => { if (seekMode !== "frame") setIsSeekingMedia(false) }}
              onError={(event) => {
                frameStepsRef.current?.cancel()
                pausedFrameTimeRef.current = null
                const message = event.currentTarget.error?.message
                if (message) setSeekError(message)
                setIsSeekingMedia(false)
                onEnded()
                onPlaybackError()
              }}
            />
          )}
          {/* overlays */}
          {videoInfo.hasVideo === false && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/70"><Volume2 className="size-14" /><span>{videoInfo.filename}</span></div>}
          <div className="pointer-events-none absolute inset-0">
            <div className="pointer-events-auto absolute inset-0">
              {visibleAnnotations.map((a) => (
                <AnnotationOverlay
                  key={a.id}
                  a={a}
                  selected={a.id === selectedId}
                  activeTool={activeTool}
                  onSelect={onSelectAnnotation}
                  onMoveStart={handleMoveStart}
                  unitScale={surfaceSize.height / 540}
                />
              ))}
              {selectedAnnotation && !drawingTools.has(activeTool) && <button type="button"
                aria-label="Переместить выбранный объект"
                title="Перетащите для перемещения выбранного объекта. Escape — снять выделение."
                className="absolute cursor-move border border-dashed border-primary bg-transparent"
                style={{ left: `${selectedAnnotation.x * 100}%`, top: `${selectedAnnotation.y * 100}%`, width: `${selectedAnnotation.width * 100}%`, height: `${selectedAnnotation.height * 100}%` }}
                onPointerDown={event => handleMoveStart(event, selectedAnnotation)}
                onClick={event => event.stopPropagation()} />}
            </div>
          </div>
          {draft && <DraftOverlay draft={draft} />}
          {!showGap && (isSeekingMedia || isReadingFrames) && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
              {isReadingFrames ? "Reading frame timestamps…" : "Seeking…"}
            </div>
          )}
          {seekError && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-center text-xs text-destructive-foreground">
              {seekError}
            </div>
          )}
          {/* center play affordance */}
          {!isPlaying && playbackUrl && activeTool === "select" && !selectedId && (
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
          max={Math.max(frame, duration)}
          disabled={duration <= 0}
          step={frame}
          onValueChange={(v) => onSeek(Array.isArray(v) ? v[0] : v, "preview")}
          onValueCommitted={(v) => onSeek(Array.isArray(v) ? v[0] : v, "precise")}
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
          <ControlButton label="Previous frame" disabled={videoInfo.hasVideo === false} onClick={() => requestFrameStep(-1)}>
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
          <ControlButton label="Next frame" disabled={videoInfo.hasVideo === false} onClick={() => requestFrameStep(1)}>
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
