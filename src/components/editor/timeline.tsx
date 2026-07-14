"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  MapPin,
  Video,
  Music,
  Type,
  PenLine,
  Magnet,
  Split,
  Trash2,
} from "lucide-react"
import type { Annotation, TimelineClip, TimelineMarker, VideoInfo } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import type { MediaService } from "@/services/media-service"
import type { TimelineThumbnail } from "@/types/media"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { generateClientTimelineThumbnails } from "./timeline/client-thumbnailer"
import { selectTimelineLod } from "./timeline/lod-selector"
import { renderTimelineCanvas } from "./timeline/timeline-renderer"
import { ThumbnailCache, loadBitmapFromUrl } from "./timeline/thumbnail-cache"
import { ThumbnailJobQueue, type TimelineThumbnailStatus } from "./timeline/thumbnail-request-manager"
import {
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  clamp,
  createTimelineScale,
  zoomAroundCursor,
} from "./timeline/timeline-scale"
import { calculateVisibleRange, type VisibleRange } from "./timeline/visible-range"
import {
  ANNOTATION_LANE_HEIGHT,
  annotationLaneTop,
  assignAnnotationLanes,
} from "./timeline/annotation-lanes"

interface TimelineProps {
  currentTime: number
  duration: number
  playbackUrl: string | null
  originalPath: string | null
  videoId: string | null
  thumbnails: TimelineThumbnail[]
  mediaService: MediaService
  videoInfo: VideoInfo
  audioPeaks: number[]
  onSeek: (t: number) => void
  pxPerSecond: number
  onPxPerSecondChange: (v: number) => void
  markers: TimelineMarker[]
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  onSelectClip: (id: string, additive?: boolean) => void
  onSplitClip: () => void
  onDeleteClip: () => void
  annotations: Annotation[]
  selectedId: string | null
  onSelectAnnotation: (id: string | null) => void
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void
  trim: [number, number]
  onTrimChange: (t: [number, number]) => void
  onAddMarker: () => void
  onCacheDirChange?: (cacheDir: string | null) => void
}

function nearestTrackAnnotation(
  annotations: Annotation[],
  range: VisibleRange,
  pxPerSecond: number,
  clientX: number,
  rectLeft: number,
) {
  const time = (range.scrollLeft + clientX - rectLeft) / pxPerSecond
  return annotations.find((annotation) => time >= annotation.startTime && time <= annotation.endTime) ?? null
}

export function Timeline({
  currentTime,
  duration,
  playbackUrl,
  originalPath,
  videoId,
  thumbnails,
  mediaService,
  videoInfo,
  audioPeaks,
  onSeek,
  pxPerSecond,
  onPxPerSecondChange,
  markers,
  clips,
  selectedClipId,
  selectedClipIds,
  onSelectClip,
  onSplitClip,
  onDeleteClip,
  annotations,
  selectedId,
  onSelectAnnotation,
  onUpdateAnnotation,
  trim,
  onTrimChange,
  onAddMarker,
  onCacheDirChange,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const zoomDebounceRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const clientGenerationRef = useRef(0)
  const userZoomedRef = useRef(false)
  const [thumbnailCache] = useState(() => new ThumbnailCache())
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 })
  const [cacheVersion, setCacheVersion] = useState(0)
  const [thumbnailStatus, setThumbnailStatus] = useState<TimelineThumbnailStatus>({
    generation: 0,
    cacheDir: null,
    states: new Map(),
  })

  const scale = useMemo(
    () => createTimelineScale(pxPerSecond, videoInfo.fps),
    [pxPerSecond, videoInfo.fps],
  )
  const lod = useMemo(
    () => selectTimelineLod(scale.pixelsPerSecond, scale.fps),
    [scale.fps, scale.pixelsPerSecond],
  )
  const width = Math.max(duration * scale.pixelsPerSecond, viewport.width)
  const range = useMemo(
    () =>
      calculateVisibleRange({
        scrollLeft: viewport.scrollLeft,
        viewportWidth: viewport.width,
        pixelsPerSecond: scale.pixelsPerSecond,
        duration,
      }),
    [duration, scale.pixelsPerSecond, viewport.scrollLeft, viewport.width],
  )

  const jobQueue = useMemo(
    () =>
      new ThumbnailJobQueue(mediaService, thumbnailCache, (status) => {
        setThumbnailStatus(status)
        onCacheDirChange?.(status.cacheDir)
      }),
    [mediaService, onCacheDirChange, thumbnailCache],
  )

  const hasAnnotations = annotations.length > 0
  const hasAudio = Boolean(playbackUrl) && videoInfo.audioStreams !== "None"
  const hasSubtitles = videoInfo.subtitles !== "None"
  const showClipControls =
    clips.length > 1 ||
    clips.some((clip) => Math.abs(clip.startTime) >= 0.001 || Math.abs(clip.endTime - duration) >= 0.001)
  const tracks = useMemo(
    () => [
      { id: "video", label: "Video 1", icon: Video },
      ...(hasAnnotations ? [{ id: "annotations", label: "Annotations", icon: PenLine }] : []),
      ...(hasAudio ? [{ id: "audio", label: "Audio 1", icon: Music }] : []),
      ...(hasSubtitles ? [{ id: "subtitles", label: "Subtitles", icon: Type }] : []),
    ],
    [hasAnnotations, hasAudio, hasSubtitles],
  )
  const annotationLanes = useMemo(() => assignAnnotationLanes(annotations), [annotations])

  const scheduleViewportRead = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollRef.current
      if (!el) return
      setViewport({ width: el.clientWidth, scrollLeft: el.scrollLeft })
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const sync = () => {
      setViewport({ width: el.clientWidth, scrollLeft: el.scrollLeft })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    userZoomedRef.current = false
  }, [duration, videoId])

  useEffect(() => {
    if (duration <= 0 || viewport.width <= 0 || userZoomedRef.current) return

    const fittedPixelsPerSecond = clamp(
      viewport.width / duration,
      MIN_PIXELS_PER_SECOND,
      MAX_PIXELS_PER_SECOND,
    )
    if (Math.abs(fittedPixelsPerSecond - pxPerSecond) < 0.001) return

    onPxPerSecondChange(fittedPixelsPerSecond)
  }, [duration, onPxPerSecondChange, pxPerSecond, viewport.width])

  useEffect(() => {
    if (!videoId || thumbnails.length === 0) return
    let cancelled = false
    void Promise.all(
      thumbnails.map(async (thumbnail) => {
        try {
          const bitmap = await loadBitmapFromUrl(thumbnail.url)
          if (cancelled) {
            bitmap.close()
            return
          }
          thumbnailCache.set(videoId, lod.intervalSeconds, thumbnail.time, bitmap, thumbnail.url)
          setCacheVersion((version) => version + 1)
        } catch {
          // Old fixed thumbnails are an opportunistic warm cache only.
        }
      }),
    )
    return () => {
      cancelled = true
    }
  }, [lod.intervalSeconds, thumbnailCache, thumbnails, videoId])

  useEffect(() => {
    if (!playbackUrl || !videoId || duration <= 0 || viewport.width <= 0) return

    clientGenerationRef.current += 1
    const generation = clientGenerationRef.current
    const timeout = window.setTimeout(() => {
      void generateClientTimelineThumbnails({
        playbackUrl,
        videoId,
        range,
        intervalSeconds: lod.intervalSeconds,
        thumbnailWidth: Math.round(lod.thumbnailWidth),
        thumbnailHeight: 34,
        duration,
        cache: thumbnailCache,
        generation,
        isCurrent: (candidate) => candidate === clientGenerationRef.current,
        onFrame: () => setCacheVersion((version) => version + 1),
      })
    }, 180)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [
    duration,
    lod.intervalSeconds,
    lod.thumbnailWidth,
    playbackUrl,
    range,
    thumbnailCache,
    videoId,
    viewport.width,
  ])

  const requestThumbnails = useCallback(
    (generation: number) => {
      if (!originalPath || !videoId || duration <= 0 || viewport.width <= 0) return
      jobQueue.request(
        {
          videoId,
          filePath: originalPath,
          startTime: range.requestStart,
          endTime: range.requestEnd,
          intervalSeconds: lod.intervalSeconds,
          thumbnailWidth: Math.round(lod.thumbnailWidth),
          generation,
        },
        10,
      )
    },
    [
      duration,
      jobQueue,
      lod.intervalSeconds,
      lod.thumbnailWidth,
      originalPath,
      range.requestEnd,
      range.requestStart,
      videoId,
      viewport.width,
    ],
  )

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    jobQueue.cancelQueuedBefore(generation)

    if (zoomDebounceRef.current != null) window.clearTimeout(zoomDebounceRef.current)
    zoomDebounceRef.current = window.setTimeout(() => {
      requestThumbnails(generation)
    }, 150)

    return () => {
      if (zoomDebounceRef.current != null) window.clearTimeout(zoomDebounceRef.current)
    }
  }, [jobQueue, requestThumbnails])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || viewport.width <= 0) return

    const frame = requestAnimationFrame(() => {
      renderTimelineCanvas(canvas, {
        duration,
        currentTime,
        trim,
        clips,
        selectedClipId,
        selectedClipIds,
        markers,
        annotations,
        selectedId,
        hasAudio,
        hasSubtitles,
        audioPeaks,
        videoId: videoId ?? "no-video",
        range,
        scale,
        lod,
        cache: thumbnailCache,
        states: thumbnailStatus.states,
      })
    })

    return () => cancelAnimationFrame(frame)
  }, [
    annotations,
    audioPeaks,
    currentTime,
    duration,
    hasAudio,
    hasSubtitles,
    lod,
    markers,
    range,
    scale,
    selectedId,
    thumbnailStatus,
    thumbnailCache,
    cacheVersion,
    clips,
    trim,
    selectedClipId,
    selectedClipIds,
    videoId,
    viewport.width,
  ])

  useEffect(() => () => thumbnailCache.clear(), [thumbnailCache])

  const timeFromClientX = useCallback(
    (clientX: number, snap = false, bounds: [number, number] = [0, duration]) => {
      const el = scrollRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const x = clientX - rect.left + el.scrollLeft
      const rawTime = scale.xToTime(x)
      return clamp(scale.snapTime(rawTime, snap), bounds[0], bounds[1])
    },
    [duration, scale],
  )

  const handleScrub = useCallback(
    (event: React.PointerEvent) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const localY = event.clientY - rect.top
      const time = timeFromClientX(event.clientX, scale.pixelsPerFrame >= 20)

      if (localY >= 34 && localY <= 74) {
        const clip = clips.find((candidate) => time >= candidate.startTime && time <= candidate.endTime)
        const additive = event.ctrlKey || event.metaKey
        if (clip) {
          onSelectClip(clip.id, additive)
          if (additive) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
      }

      const annotation = nearestTrackAnnotation(
        annotations,
        range,
        scale.pixelsPerSecond,
        event.clientX,
        rect.left,
      )
      if (annotation && localY >= 78 && localY <= 118) {
        onSelectAnnotation(annotation.id)
        return
      }

      onSeek(time)
      const move = (moveEvent: PointerEvent) => {
        onSeek(timeFromClientX(moveEvent.clientX, scale.pixelsPerFrame >= 20))
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [
      annotations,
      clips,
      onSeek,
      onSelectAnnotation,
      onSelectClip,
      range,
      scale,
      timeFromClientX,
    ],
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey || duration <= 0) return

      event.preventDefault()
      const el = scrollRef.current
      if (!el) return

      const rect = el.getBoundingClientRect()
      const next = zoomAroundCursor({
        currentPixelsPerSecond: scale.pixelsPerSecond,
        deltaY: event.deltaY,
        cursorX: event.clientX - rect.left,
        scrollLeft: el.scrollLeft,
      })
      userZoomedRef.current = true
      onPxPerSecondChange(next.pixelsPerSecond)
      requestAnimationFrame(() => {
        el.scrollLeft = next.scrollLeft
        scheduleViewportRead()
      })
    },
    [duration, onPxPerSecondChange, scale.pixelsPerSecond, scheduleViewportRead],
  )

  const dragTrim = useCallback(
    (which: 0 | 1) => (event: React.PointerEvent) => {
      event.stopPropagation()
      const move = (moveEvent: PointerEvent) => {
        const time = timeFromClientX(moveEvent.clientX, scale.pixelsPerFrame >= 20)
        const next: [number, number] = [...trim]
        if (which === 0) next[0] = Math.min(time, trim[1] - scale.frameDuration)
        else next[1] = Math.max(time, trim[0] + scale.frameDuration)
        onTrimChange(next)
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [onTrimChange, scale.frameDuration, scale.pixelsPerFrame, timeFromClientX, trim],
  )

  const setInAtPlayhead = useCallback(() => {
    onTrimChange([Math.min(currentTime, trim[1] - scale.frameDuration), trim[1]])
  }, [currentTime, onTrimChange, scale.frameDuration, trim])

  const setOutAtPlayhead = useCallback(() => {
    onTrimChange([trim[0], Math.max(currentTime, trim[0] + scale.frameDuration)])
  }, [currentTime, onTrimChange, scale.frameDuration, trim])

  const dragAnnotationTime = useCallback(
    (annotation: Annotation, mode: "move" | "start" | "end") => (event: React.PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      onSelectAnnotation(annotation.id)

      const startTime = annotation.startTime
      const endTime = annotation.endTime
      const span = Math.max(scale.frameDuration, endTime - startTime)
      const pointerStart = timeFromClientX(event.clientX, scale.pixelsPerFrame >= 20)

      const move = (moveEvent: PointerEvent) => {
        const pointerTime = timeFromClientX(moveEvent.clientX, scale.pixelsPerFrame >= 20)
        const delta = pointerTime - pointerStart
        if (mode === "move") {
          const nextStart = clamp(startTime + delta, 0, Math.max(0, duration - span))
          onUpdateAnnotation(annotation.id, {
            startTime: nextStart,
            endTime: Math.min(duration, nextStart + span),
          })
          return
        }

        if (mode === "start") {
          onUpdateAnnotation(annotation.id, {
            startTime: clamp(startTime + delta, 0, endTime - scale.frameDuration),
          })
          return
        }

        onUpdateAnnotation(annotation.id, {
          endTime: clamp(endTime + delta, startTime + scale.frameDuration, duration),
        })
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [duration, onSelectAnnotation, onUpdateAnnotation, scale.frameDuration, scale.pixelsPerFrame, timeFromClientX],
  )

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Timeline
        </div>
        <div className="mx-1 h-4 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onAddMarker}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
              >
                <MapPin className="size-3.5" />
                Marker
              </button>
            }
          />
          <TooltipContent>Add marker at playhead (M)</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={setInAtPlayhead}
          className="rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
        >
          Set In
        </button>
        <button
          type="button"
          onClick={setOutAtPlayhead}
          className="rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
        >
          Set Out
        </button>

        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent/15",
            scale.pixelsPerFrame >= 20 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Magnet className="size-3.5" />
          Snap
        </button>

        <div className="ml-auto flex items-center gap-2">
          {showClipControls && (
            <select
              value={selectedClipId ?? ""}
              onChange={(event) => event.currentTarget.value && onSelectClip(event.currentTarget.value, false)}
              className="h-7 max-w-44 rounded-md border border-border bg-secondary/60 px-2 text-xs text-foreground outline-none"
              aria-label="Selected clip"
            >
              {clips.map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clip.label} ({clip.startTime.toFixed(1)}-{clip.endTime.toFixed(1)}s)
                </option>
              ))}
            </select>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onSplitClip}
                  disabled={!selectedClipId}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Split clip"
                >
                  <Split className="size-3.5" />
                </button>
              }
            />
            <TooltipContent>Split clip at playhead (S)</TooltipContent>
          </Tooltip>
          {showClipControls && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onDeleteClip}
                    disabled={clips.length <= 1}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Delete clip"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                }
              />
              <TooltipContent>Delete selected clip</TooltipContent>
            </Tooltip>
          )}
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {scale.pixelsPerSecond < 1 ? scale.pixelsPerSecond.toFixed(2) : Math.round(scale.pixelsPerSecond)} px/s
            <span className="mx-1 text-muted-foreground/50">·</span>
            {lod.label}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-32 shrink-0 border-r border-border">
          <div className="h-7 border-b border-border" />
          {tracks.map((track) => {
            const Icon = track.icon
            return (
              <div
                key={track.id}
                className="flex h-11 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground"
              >
                <Icon className="size-3.5" />
                <span className="truncate">{track.label}</span>
              </div>
            )
          })}
        </div>

        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-x-auto"
          onScroll={scheduleViewportRead}
          onWheel={handleWheel}
        >
          <div className="relative h-full" style={{ width }}>
            <canvas
              ref={canvasRef}
              className="sticky left-0 top-0 block h-full"
              style={{ width: viewport.width, height: "100%" }}
              onPointerDown={handleScrub}
            />
            {annotations.map((annotation) => {
              const left = scale.timeToX(annotation.startTime)
              const annotationWidth = Math.max(28, (annotation.endTime - annotation.startTime) * scale.pixelsPerSecond)
              const isSelected = annotation.id === selectedId
              const lane = annotationLanes.get(annotation.id) ?? 0
              return (
                <div
                  key={annotation.id}
                  className="absolute z-20"
                  style={{
                    left,
                    top: annotationLaneTop(lane),
                    width: annotationWidth,
                    height: ANNOTATION_LANE_HEIGHT,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Move ${annotation.label}`}
                    onPointerDown={dragAnnotationTime(annotation, "move")}
                    className={cn(
                      "absolute inset-0 rounded-sm border text-[0px] transition-colors",
                      isSelected
                        ? "border-primary/70 bg-primary/10"
                        : "border-transparent bg-transparent hover:border-primary/35 hover:bg-primary/5",
                    )}
                  />
                  <button
                    type="button"
                    aria-label={`Resize ${annotation.label} start`}
                    onPointerDown={dragAnnotationTime(annotation, "start")}
                    className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize rounded-l-sm bg-primary/0 hover:bg-primary/70"
                  />
                  <button
                    type="button"
                    aria-label={`Resize ${annotation.label} end`}
                    onPointerDown={dragAnnotationTime(annotation, "end")}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r-sm bg-primary/0 hover:bg-primary/70"
                  />
                </div>
              )
            })}
            <div
              className="absolute z-10 cursor-ew-resize"
              style={{
                left: scale.timeToX(trim[0]) - 5,
                top: 38,
                width: 10,
                height: 32,
              }}
              onPointerDown={dragTrim(0)}
            />
            <div
              className="absolute z-10 cursor-ew-resize"
              style={{
                left: scale.timeToX(trim[1]) - 5,
                top: 38,
                width: 10,
                height: 32,
              }}
              onPointerDown={dragTrim(1)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
