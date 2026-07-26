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
  LoaderCircle,
  CheckCircle2,
} from "lucide-react"
import type { Annotation, TimelineClip, TimelineMarker, VideoInfo } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import type { MediaService } from "@/services/media-service"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { playbackClock } from "@/stores/playback-clock"
import { usePerformanceStore } from "@/stores/performance-store"
import { alignTimeToLod, selectTimelineLod } from "./timeline/lod-selector"
import { renderTimelineCanvas, renderTimelinePlayhead } from "./timeline/timeline-renderer"
import { ThumbnailCache } from "./timeline/thumbnail-cache"
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

const THUMBNAIL_SCHEDULER = {
  playingBatchSize: 3,
  visibleBatchSize: 3,
  pausedBatchSize: 6,
  visibleDelayMs: 80,
  nearDelayMs: 300,
  prefetchDelayMs: 800,
} as const
const WAVEFORM_SECONDS_PER_PEAK = 25
const WAVEFORM_CHUNK_SECONDS = 300
const WAVEFORM_IDLE_DELAY_MS = 1_500
const WAVEFORM_CHUNK_YIELD_MS = 350
const WAVEFORM_ENABLED = false

interface TimelineProps {
  duration: number
  playbackUrl: string | null
  originalPath: string | null
  videoId: string | null
  mediaService: MediaService
  videoInfo: VideoInfo
  isPlaying: boolean
  onSeek: (t: number, mode?: "preview" | "precise") => void
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
  duration,
  playbackUrl,
  originalPath,
  videoId,
  mediaService,
  videoInfo,
  isPlaying,
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
  const playheadCanvasRef = useRef<HTMLCanvasElement>(null)
  const playheadHandleRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const userZoomedRef = useRef(false)
  const lastActivitySignalRef = useRef(0)
  const [thumbnailCache] = useState(() => new ThumbnailCache())
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 })
  const [waveformCache, setWaveformCache] = useState<{ videoId: string | null; peaks: number[] }>({
    videoId: null,
    peaks: [],
  })
  const audioPeaks = useMemo(
    () => (waveformCache.videoId === videoId ? waveformCache.peaks : []),
    [videoId, waveformCache],
  )
  const performanceConfig = usePerformanceStore((state) => state.config)
  const setPerformanceConfig = usePerformanceStore((state) => state.setConfig)
  const thumbnailBatchBudget = performanceConfig?.thumbnailBudget.batchSize
  const thumbnailPrefetchAllowed = performanceConfig?.thumbnailBudget.prefetchAllowed
  const waveformAllowed = performanceConfig?.waveformBudget.allowed
  const waveformChunkBudget = performanceConfig?.waveformBudget.maxChunkSeconds
  const waveformGenerationRef = useRef(0)
  const waveformChunksRef = useRef(new Set<string>())
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

  useEffect(() => {
    const budget = performanceConfig?.thumbnailBudget
    if (!budget) return
    thumbnailCache.configure(250, budget.ramCacheBytes)
    jobQueue.setDecodeConcurrency(budget.decodeConcurrency)
  }, [jobQueue, performanceConfig, thumbnailCache])

  useEffect(() => {
    waveformGenerationRef.current += 1
    waveformChunksRef.current.clear()
  }, [videoId])

  const hasAnnotations = annotations.length > 0
  const hasAudio =
    WAVEFORM_ENABLED && Boolean(playbackUrl) && videoInfo.audioStreams !== "None"
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
  const timelineProgress = useMemo(() => {
    if (!videoId) return { total: 0, ready: 0, pending: 0 }
    const prefix = `${videoId}:${Math.round(lod.intervalSeconds * 1000)}:`
    const activeStates = [...thumbnailStatus.states.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, state]) => state)
      .filter((state) => state === "queued" || state === "loading")
    let total = 0
    let ready = 0
    const progressStart = alignTimeToLod(range.visibleStart, lod.intervalSeconds)
    const progressEnd = Math.min(duration, range.visibleEnd)
    for (let time = progressStart; time < progressEnd; time += lod.intervalSeconds) {
      total += 1
      const rounded = Math.round(time * 1000) / 1000
      if (
        thumbnailCache.get(videoId, lod.intervalSeconds, rounded) ||
        thumbnailCache.getAtTimestamp(videoId, rounded) ||
        thumbnailCache.findNearest(videoId, lod.intervalSeconds, rounded, lod.intervalSeconds)
      ) {
        ready += 1
      }
    }
    return {
      total,
      ready,
      pending: activeStates.length,
    }
  }, [
    duration,
    lod.intervalSeconds,
    range.visibleEnd,
    range.visibleStart,
    thumbnailCache,
    thumbnailStatus.states,
    videoId,
  ])

  const scheduleViewportRead = useCallback(() => {
    const now = Date.now()
    if (now - lastActivitySignalRef.current >= 1000) {
      lastActivitySignalRef.current = now
      void mediaService
        .updateRuntimeMetrics({
          droppedFrameRatio: performanceConfig?.droppedFrameRatio ?? 0,
          userActive: true,
          windowVisible: document.visibilityState === "visible",
        })
        .then(setPerformanceConfig)
        .catch(() => undefined)
    }
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollRef.current
      if (!el) return
      setViewport({ width: el.clientWidth, scrollLeft: el.scrollLeft })
    })
  }, [mediaService, performanceConfig?.droppedFrameRatio, setPerformanceConfig])

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

  const requestThumbnails = useCallback(
    (
      generation: number,
      startTime: number,
      endTime: number,
      priority: number,
      priorityLevel: "visible" | "near" | "prefetch",
      batchSize: number,
    ) => {
      if (!originalPath || !videoId || duration <= 0 || viewport.width <= 0 || endTime <= startTime) return
      const interval = lod.intervalSeconds
      const first = alignTimeToLod(Math.max(0, startTime), interval)
      const timestamps: number[] = []
      for (let time = first; time <= Math.min(duration, endTime) + interval * 0.25; time += interval) {
        const rounded = Math.round(time * 1000) / 1000
        if (
          !thumbnailCache.get(videoId, interval, rounded) &&
          !thumbnailCache.getAtTimestamp(videoId, rounded)
        ) {
          timestamps.push(rounded)
        }
      }
      const center = (range.visibleStart + range.visibleEnd) / 2
      const batches: number[][] = []
      for (let offset = 0; offset < timestamps.length; offset += batchSize) {
        batches.push(timestamps.slice(offset, offset + batchSize))
      }
      batches
        .sort((left, right) => {
          const leftCenter = (left[0] + left[left.length - 1]) / 2
          const rightCenter = (right[0] + right[right.length - 1]) / 2
          return Math.abs(leftCenter - center) - Math.abs(rightCenter - center)
        })
        .forEach((batch, index) => {
          jobQueue.request(
            {
              videoId,
              filePath: originalPath,
              startTime: batch[0],
              endTime: batch[batch.length - 1],
              intervalSeconds: interval,
              thumbnailWidth: Math.round(lod.thumbnailWidth),
              thumbnailHeight: 30,
              generation,
              priority: priorityLevel,
            },
            priority - index * 0.001,
          )
        })
    },
    [
      duration,
      jobQueue,
      lod.intervalSeconds,
      lod.thumbnailWidth,
      originalPath,
      range.visibleEnd,
      range.visibleStart,
      thumbnailCache,
      videoId,
      viewport.width,
    ],
  )

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    jobQueue.cancelQueuedBefore(generation)
    void mediaService.cancelBackgroundMedia().catch(() => undefined)
    const configuredBatchSize = thumbnailBatchBudget
    const batchSize = configuredBatchSize ?? (isPlaying
      ? THUMBNAIL_SCHEDULER.playingBatchSize
      : THUMBNAIL_SCHEDULER.pausedBatchSize)
    const timers = [
      window.setTimeout(() => {
        requestThumbnails(
          generation,
          range.visibleStart,
          range.visibleEnd,
          300,
          "visible",
          isPlaying ? batchSize : THUMBNAIL_SCHEDULER.visibleBatchSize,
        )
      }, THUMBNAIL_SCHEDULER.visibleDelayMs),
    ]
    if (!isPlaying) {
      timers.push(
        window.setTimeout(() => {
          requestThumbnails(generation, range.nearStart, range.visibleStart, 200, "near", batchSize)
          requestThumbnails(generation, range.visibleEnd, range.nearEnd, 200, "near", batchSize)
        }, THUMBNAIL_SCHEDULER.nearDelayMs),
        ...(thumbnailPrefetchAllowed !== false
          ? [window.setTimeout(() => {
              requestThumbnails(generation, range.prefetchStart, range.nearStart, 100, "prefetch", batchSize)
              requestThumbnails(generation, range.nearEnd, range.prefetchEnd, 100, "prefetch", batchSize)
            }, THUMBNAIL_SCHEDULER.prefetchDelayMs)]
          : []),
      )
    }

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [
    isPlaying,
    jobQueue,
    mediaService,
    range,
    requestThumbnails,
    thumbnailBatchBudget,
    thumbnailPrefetchAllowed,
  ])

  useEffect(() => {
    if (
      isPlaying ||
      !originalPath ||
      !videoId ||
      !hasAudio ||
      waveformAllowed === false ||
      duration <= 0 ||
      range.requestEnd <= range.requestStart
    ) return

    const generation = waveformGenerationRef.current
    const chunkSeconds =
      waveformChunkBudget || WAVEFORM_CHUNK_SECONDS
    const firstChunk = Math.floor(range.requestStart / chunkSeconds)
    const lastChunk = Math.max(firstChunk, Math.ceil(range.requestEnd / chunkSeconds) - 1)
    const visibleCenter = (range.visibleStart + range.visibleEnd) / 2
    const chunks = Array.from(
      { length: lastChunk - firstChunk + 1 },
      (_, index) => firstChunk + index,
    ).sort((left, right) => {
      const leftCenter = (left + 0.5) * chunkSeconds
      const rightCenter = (right + 0.5) * chunkSeconds
      return Math.abs(leftCenter - visibleCenter) - Math.abs(rightCenter - visibleCenter)
    })
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void (async () => {
        for (const chunk of chunks) {
          if (cancelled || generation !== waveformGenerationRef.current) return
          const chunkKey = `${videoId}:${chunkSeconds}:${chunk}`
          if (waveformChunksRef.current.has(chunkKey)) continue
          waveformChunksRef.current.add(chunkKey)
          const startTime = chunk * chunkSeconds
          const endTime = Math.min(duration, startTime + chunkSeconds)
          let waveform
          try {
            waveform = await mediaService.generateAudioWaveform({
              videoId,
              filePath: originalPath,
              startTime,
              endTime,
              peakCount: Math.max(
                1,
                Math.ceil((endTime - startTime) / WAVEFORM_SECONDS_PER_PEAK),
              ),
            })
          } catch {
            waveformChunksRef.current.delete(chunkKey)
            return
          }
          if (generation !== waveformGenerationRef.current || waveform.videoId !== videoId) return
          const totalPeakCount = Math.max(
            1,
            Math.ceil(duration / WAVEFORM_SECONDS_PER_PEAK),
          )
          setWaveformCache((previous) => {
            const previousPeaks = previous.videoId === videoId ? previous.peaks : []
            const next = previousPeaks.length === totalPeakCount
              ? [...previousPeaks]
              : new Array<number>(totalPeakCount).fill(0)
            waveform.peaks.forEach((peak, index) => {
              const time = waveform.startTime +
                (index / Math.max(1, waveform.peaks.length)) * (waveform.endTime - waveform.startTime)
              const target = Math.min(totalPeakCount - 1, Math.floor((time / duration) * totalPeakCount))
              next[target] = peak
            })
            return { videoId, peaks: next }
          })
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, WAVEFORM_CHUNK_YIELD_MS)
          })
        }
      })().catch(() => undefined)
    }, WAVEFORM_IDLE_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [
    duration,
    hasAudio,
    isPlaying,
    mediaService,
    originalPath,
    range.requestEnd,
    range.requestStart,
    range.visibleEnd,
    range.visibleStart,
    videoId,
    waveformAllowed,
    waveformChunkBudget,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || viewport.width <= 0) return

    const frame = requestAnimationFrame(() => {
      renderTimelineCanvas(canvas, {
        duration,
        currentTime: 0,
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
    clips,
    trim,
    selectedClipId,
    selectedClipIds,
    videoId,
    viewport.width,
  ])

  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas || viewport.width <= 0) return
    let frame: number | null = null
    const draw = (time = playbackClock.getSnapshot()) => {
      const handle = playheadHandleRef.current
      if (handle) {
        const x = scale.timeToX(time) - range.scrollLeft
        handle.style.transform = `translate3d(${x - 10}px, 0, 0)`
        handle.style.visibility = x >= -10 && x <= viewport.width + 10 ? "visible" : "hidden"
      }
      if (frame != null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
      renderTimelinePlayhead(canvas, {
        duration,
        currentTime: time,
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
    }
    draw()
    const unsubscribe = playbackClock.subscribe(draw)
    return () => {
      unsubscribe()
      if (frame != null) cancelAnimationFrame(frame)
    }
  }, [
    annotations,
    audioPeaks,
    clips,
    duration,
    hasAudio,
    hasSubtitles,
    lod,
    markers,
    range,
    scale,
    selectedClipId,
    selectedClipIds,
    selectedId,
    thumbnailCache,
    thumbnailStatus.states,
    trim,
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

  const movePlayheadFromPointer = useCallback(
    (clientX: number) => {
      const time = timeFromClientX(clientX, scale.pixelsPerFrame >= 20)
      playbackClock.set(time)
      onSeek(time, "preview")
    },
    [onSeek, scale.pixelsPerFrame, timeFromClientX],
  )

  const handlePlayheadPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      movePlayheadFromPointer(event.clientX)
    },
    [movePlayheadFromPointer],
  )

  const handlePlayheadPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      if ((event.buttons & 1) === 0) {
        event.currentTarget.releasePointerCapture(event.pointerId)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      movePlayheadFromPointer(event.clientX)
    },
    [movePlayheadFromPointer],
  )

  const handleScrub = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
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

      movePlayheadFromPointer(event.clientX)
      let active = true
      let lastScrubTime = time
      const cleanup = () => {
        if (!active) return
        active = false
        onSeek(lastScrubTime, "precise")
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", cleanup)
        window.removeEventListener("pointercancel", cleanup)
        window.removeEventListener("blur", cleanup)
      }
      const move = (moveEvent: PointerEvent) => {
        if ((moveEvent.buttons & 1) === 0) {
          cleanup()
          return
        }
        lastScrubTime = timeFromClientX(moveEvent.clientX, scale.pixelsPerFrame >= 20)
        movePlayheadFromPointer(moveEvent.clientX)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", cleanup)
      window.addEventListener("pointercancel", cleanup)
      window.addEventListener("blur", cleanup)
    },
    [
      annotations,
      clips,
      onSeek,
      onSelectAnnotation,
      onSelectClip,
      range,
      scale,
      movePlayheadFromPointer,
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
    const currentTime = playbackClock.getSnapshot()
    onTrimChange([Math.min(currentTime, trim[1] - scale.frameDuration), trim[1]])
  }, [onTrimChange, scale.frameDuration, trim])

  const setOutAtPlayhead = useCallback(() => {
    const currentTime = playbackClock.getSnapshot()
    onTrimChange([trim[0], Math.max(currentTime, trim[0] + scale.frameDuration)])
  }, [onTrimChange, scale.frameDuration, trim])

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
          {timelineProgress.total > 0 &&
          timelineProgress.ready >= timelineProgress.total ? (
            <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="size-3" />
              Timeline ready
            </span>
          ) : timelineProgress.pending > 0 ? (
            <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-[11px] text-primary">
              <LoaderCircle className="size-3 animate-spin" />
              Optimizing timeline {timelineProgress.ready}/{timelineProgress.total}
            </span>
          ) : timelineProgress.total > 0 ? (
            <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="size-3" />
              Timeline ready
            </span>
          ) : videoId ? (
            <span className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Preparing timeline
            </span>
          ) : null}
          <select
            value={performanceConfig?.preset ?? "auto"}
            onChange={(event) => {
              const preset = event.currentTarget.value as NonNullable<typeof performanceConfig>["preset"]
              void mediaService
                .setPerformancePreset(preset)
                .then(() => mediaService.getRuntimePerformanceConfig())
                .then(setPerformanceConfig)
                .catch(() => undefined)
            }}
            className="h-7 rounded-md border border-border bg-secondary/60 px-2 text-xs text-foreground outline-none"
            aria-label="Performance preset"
            title={`Pressure: ${performanceConfig?.pressure ?? "unknown"}`}
          >
            <option value="auto">Auto</option>
            <option value="powerSaver">Power Saver</option>
            <option value="balanced">Balanced</option>
            <option value="performance">Performance</option>
            <option value="custom">Custom</option>
          </select>
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
              <TooltipContent>Delete selected clip (Delete)</TooltipContent>
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
            <div
              className="sticky left-0 top-0 h-full"
              style={{ width: viewport.width }}
              onPointerDown={handleScrub}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 block h-full"
                style={{ width: viewport.width, height: "100%" }}
              />
              <canvas
                ref={playheadCanvasRef}
                className="pointer-events-none absolute inset-0 z-10 block h-full"
                style={{ width: viewport.width, height: "100%" }}
              />
              <div
                ref={playheadHandleRef}
                role="slider"
                aria-label="Playhead"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={playbackClock.getSnapshot()}
                tabIndex={0}
                className="group/playhead absolute inset-y-0 left-0 z-20 w-5 cursor-col-resize touch-none select-none"
                onPointerDown={handlePlayheadPointerDown}
                onPointerMove={handlePlayheadPointerMove}
                onPointerUp={(event) => {
                  event.stopPropagation()
                  onSeek(playbackClock.getSnapshot(), "precise")
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
                onPointerCancel={(event) => {
                  onSeek(playbackClock.getSnapshot(), "precise")
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
              >
                <div className="pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-rose-400/0 transition-colors group-hover/playhead:bg-rose-400/25" />
              </div>
            </div>
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
