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
  CircleAlert,
  ZoomIn,
  ZoomOut,
  Maximize2,
  EyeOff,
  ArrowUpRight, Square, Circle, Highlighter, Brush, Crop, Ruler, Droplets,
} from "lucide-react"
import type { Annotation, TimelineClip, TimelineMarker, VideoInfo } from "@/lib/editor-types"
import { ANNOTATION_NAMES, formatClock, formatTimecode } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import { sourceStart, snapToEdges, timelineGaps, visibleSourceRanges, type TimeRange } from "@/lib/timeline-edit"
import type { AudioWaveformResult } from "@/types/media"
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
import { calculateVisibleRange } from "./timeline/visible-range"
import { RULER_HEIGHT, VIDEO_ROW_HEIGHT, VIDEO_TRACK_TOP, VIDEO_TRACK_HEIGHT, ANNOTATION_ROW_HEIGHT, AUDIO_ROW_HEIGHT, SUBTITLE_ROW_HEIGHT } from "./timeline/timeline-layout"
import {
  ANNOTATION_LANE_HEIGHT,
  ANNOTATION_TRACK_TOP,
  ANNOTATION_TRACK_HEIGHT,
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
const WAVEFORM_CHUNK_SECONDS = 30
const WAVEFORM_ENABLED = true

interface TimelineProps {
  sourceDuration: number
  selectedRange: TimeRange | null
  onSelectRange: (range: TimeRange | null) => void
  onMoveClips: (ids: string[], time: number) => void
  onMoveRange: (range: TimeRange, time: number) => void
  rippleDelete: boolean
  onRippleDeleteChange: (enabled: boolean) => void
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
  onDeleteClip: (ripple?: boolean) => void
  annotations: Annotation[]
  selectedId: string | null
  onSelectAnnotation: (id: string | null) => void
  onEditStart: () => void
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void
  trim: [number, number]
  onTrimChange: (t: [number, number]) => void
  onAddMarker: () => void
  onCacheDirChange?: (cacheDir: string | null) => void
}

const annotationIcons = { arrow: ArrowUpRight, rectangle: Square, circle: Circle, text: Type,
  blur: Droplets, highlight: Highlighter, pen: PenLine, brush: Brush, crop: Crop, measure: Ruler }

export function Timeline({
  sourceDuration, selectedRange, onSelectRange, onMoveClips, onMoveRange, rippleDelete, onRippleDeleteChange,
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
  onEditStart,
  onUpdateAnnotation,
  trim,
  onTrimChange,
  onAddMarker,
  onCacheDirChange,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const annotationScrollRef = useRef<HTMLDivElement>(null)
  const [annotationScrollTop, setAnnotationScrollTop] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadCanvasRef = useRef<HTMLCanvasElement>(null)
  const playheadHandleRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const thumbnailWindowRef = useRef<{videoId: string | null; start: number; end: number} | null>(null)
  const [thumbnailRetry, setThumbnailRetry] = useState(0)
  const userZoomedRef = useRef(false)
  const lastActivitySignalRef = useRef(0)
  const [thumbnailCache] = useState(() => new ThumbnailCache())
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 })
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [rangeTool, setRangeTool] = useState(false)
  const [snapGuide, setSnapGuide] = useState<number | null>(null)
  const [dragPreview, setDragPreview] = useState<{ time: number; span: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const gestureCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => gestureCleanup.current?.(), [])
  const gaps = useMemo(() => timelineGaps(clips, duration), [clips, duration])
  const snapEdges = useMemo(() => [0, duration, ...clips.flatMap(c => [c.startTime, c.endTime]), ...markers.map(m => m.time)], [clips, markers, duration])
  const secondsPerPeak = Math.max(0.005, Math.min(25, 2 ** Math.floor(Math.log2(4 / Math.max(pxPerSecond, 0.02)))))
  const waveformKey = videoId + ":" + originalPath
  const [waveformCache, setWaveformCache] = useState<{ key: string; chunks: AudioWaveformResult[] }>({key: "", chunks: []})
  const audioPeaks = useMemo(() => waveformCache.key === waveformKey
    ? [...waveformCache.chunks].sort((left, right) => left.startTime - right.startTime) : [], [waveformCache, waveformKey])
  const performanceConfig = usePerformanceStore((state) => state.config)
  const setPerformanceConfig = usePerformanceStore((state) => state.setConfig)
  const thumbnailBatchBudget = performanceConfig?.thumbnailBudget.batchSize
  const thumbnailPrefetchAllowed = performanceConfig?.thumbnailBudget.prefetchAllowed
  const thumbnailsAllowed = performanceConfig?.thumbnailBudget.allowed !== false
  const waveformAllowed = performanceConfig?.waveformBudget.allowed
  const waveformDelay = performanceConfig?.waveformBudget.delayMs ?? 20
  const waveformPrefetch = performanceConfig?.waveformBudget.prefetchAllowed ?? false
  const waveformGenerationRef = useRef(0)
  const waveformChunksRef = useRef(new Map<string, AudioWaveformResult>())
  const waveformInFlightRef = useRef<Promise<AudioWaveformResult> | null>(null)
  const [waveformStatus, setWaveformStatus] = useState({key: "", pending: 0, deferred: false})
  const [waveformRetry, setWaveformRetry] = useState(0)
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
  const width = Math.max(duration * scale.pixelsPerSecond + viewport.width * 0.2, viewport.width)
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
  }, [videoId, originalPath])

  const hasAnnotations = annotations.length > 0
  const hasAudio =
    WAVEFORM_ENABLED && Boolean(playbackUrl) && videoInfo.audioStreams !== "None"
  const hasSubtitles = videoInfo.subtitles !== "None"
  const showClipControls =
    clips.length > 1 ||
    clips.some((clip) => Math.abs(clip.startTime) >= 0.001 || Math.abs(clip.endTime - duration) >= 0.001)
  const tracks = useMemo(
    () => [
      { id: "video", label: videoInfo.hasVideo === false ? "Audio clips" : "Video", icon: videoInfo.hasVideo === false ? Music : Video, height: VIDEO_ROW_HEIGHT },
      ...(hasAnnotations ? [{ id: "annotations", label: "Объекты", icon: PenLine, height: ANNOTATION_ROW_HEIGHT }] : []),
      ...(hasAudio ? [{ id: "audio", label: "Audio", icon: Music, height: AUDIO_ROW_HEIGHT }] : []),
      ...(hasSubtitles ? [{ id: "subtitles", label: "Subtitles", icon: Type, height: SUBTITLE_ROW_HEIGHT }] : []),
    ],
    [hasAnnotations, hasAudio, hasSubtitles, videoInfo.hasVideo],
  )
  const annotationLanes = useMemo(() => assignAnnotationLanes(annotations, scale.pixelsPerSecond), [annotations, scale.pixelsPerSecond])
  const annotationContentHeight = Math.max(ANNOTATION_TRACK_HEIGHT, annotationLaneTop([...annotationLanes.values()].reduce((count, lane) => Math.max(count, lane + 1), 0)))
  const annotationViewportTop = Math.min(annotationScrollTop, annotationContentHeight - ANNOTATION_TRACK_HEIGHT)
  // Reveal selections made in the preview or object picker, including lanes outside the viewport.
  useEffect(() => {
    const lane = selectedId ? annotationLanes.get(selectedId) : undefined
    const scroller = annotationScrollRef.current
    if (lane === undefined || !scroller) return
    const top = annotationLaneTop(lane)
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + ANNOTATION_LANE_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ANNOTATION_LANE_HEIGHT - scroller.clientHeight
  }, [selectedId, annotationLanes])
  const timelineHeight = RULER_HEIGHT + tracks.reduce((height, track) => height + track.height, 0) + 16
  const timelineProgress = useMemo(() => {
    if (!videoId) return { total: 0, ready: 0, pending: 0 }
    const prefix = `${videoId}:${Math.round(lod.intervalSeconds * 1000)}:`
    const activeStates = [...thumbnailStatus.states.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, state]) => state)
      .filter((state) => state === "queued" || state === "loading")
    let total = 0
    let ready = 0
    for (const [start, end] of visibleSourceRanges(clips, range.visibleStart, range.visibleEnd)) {
    for (let time = alignTimeToLod(start, lod.intervalSeconds); time < end; time += lod.intervalSeconds) {
      total += 1
      const rounded = Math.round(time * 1000) / 1000
      if (
        thumbnailCache.get(videoId, lod.intervalSeconds, rounded) ||
        thumbnailCache.getAtTimestamp(videoId, rounded)
      ) {
        ready += 1
      }
    }
    }
    return {
      total,
      ready,
      pending: activeStates.length,
    }
  }, [
    clips,
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
      if (videoInfo.hasVideo === false || !originalPath || !videoId || duration <= 0 || viewport.width <= 0 || endTime <= startTime) return
      const interval = lod.intervalSeconds
      const wanted = new Set<number>()
      for (const [start, end] of visibleSourceRanges(clips, startTime, endTime)) {
      for (let time = alignTimeToLod(start, interval); time < Math.min(sourceDuration, end); time += interval) {
        const rounded = Math.round(time * 1000) / 1000
        if (
          !thumbnailCache.get(videoId, interval, rounded) &&
          !thumbnailCache.getAtTimestamp(videoId, rounded)
        ) {
          wanted.add(rounded)
        }
      }
      }
      const timestamps = [...wanted].sort((a, b) => a - b)
      const center = timestamps[0] ?? 0
      const firstVisible = priorityLevel === "visible" && timestamps.length > 0
        ? timestamps.splice(timestamps.reduce((best, time, index) => Math.abs(time - center) < Math.abs(timestamps[best] - center) ? index : best, 0), 1)
        : []
      const batches: number[][] = []
      for (const time of timestamps) {
        const batch = batches[batches.length - 1]
        if (!batch || batch.length >= batchSize || Math.abs(time - batch[batch.length - 1] - interval) > .002) batches.push([time])
        else batch.push(time)
      }
      const ordered = batches.sort((left, right) => {
          const leftCenter = (left[0] + left[left.length - 1]) / 2
          const rightCenter = (right[0] + right[right.length - 1]) / 2
          return Math.abs(leftCenter - center) - Math.abs(rightCenter - center)
        })
      if (firstVisible.length) ordered.unshift(firstVisible)
      ordered.forEach((batch, index) => {
          jobQueue.request(
            {
              videoId,
              filePath: originalPath,
              startTime: batch[0],
              endTime: batch[batch.length - 1],
              intervalSeconds: interval,
              thumbnailWidth: 256,
              thumbnailHeight: 144,
              generation,
              priority: priorityLevel,
            },
            priority - index * 0.001,
          )
        })
    },
    [
      duration,
      clips,
      sourceDuration,
      jobQueue,
      lod.intervalSeconds,
      originalPath,
      thumbnailCache,
      videoId,
      viewport.width,
      videoInfo.hasVideo,
    ],
  )

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    const previous = thumbnailWindowRef.current
    thumbnailWindowRef.current = {videoId, start: range.visibleStart, end: range.visibleEnd}
    const sources = visibleSourceRanges(clips, range.visibleStart, range.visibleEnd)
    jobQueue.setViewport(videoId ?? "", Math.min(sourceDuration, ...sources.map(r => r[0])), Math.max(0, ...sources.map(r => r[1])), lod.intervalSeconds)
    const movedAway = previous && (previous.videoId !== videoId || range.visibleStart > previous.end || range.visibleEnd < previous.start)
    jobQueue.cancelQueuedBefore(generation, { reuseInFlight: !!previous && !movedAway })
    const cancelled = movedAway ? mediaService.cancelTimelineThumbnails().catch(() => undefined) : Promise.resolve()
    let active = true
    const schedule = (callback: () => void, delay: number) => window.setTimeout(() => {
      void cancelled.then(() => { if (active && generationRef.current === generation) callback() })
    }, delay)
    if (!thumbnailsAllowed) return
    const configuredBatchSize = thumbnailBatchBudget
    const batchSize = configuredBatchSize ?? (isPlaying
      ? THUMBNAIL_SCHEDULER.playingBatchSize
      : THUMBNAIL_SCHEDULER.pausedBatchSize)
    const timers = [
      schedule(() => {
        requestThumbnails(
          generation,
          range.visibleStart,
          range.visibleEnd,
          300,
          "visible",
          isPlaying ? batchSize : Math.min(batchSize, THUMBNAIL_SCHEDULER.visibleBatchSize),
        )
      }, THUMBNAIL_SCHEDULER.visibleDelayMs),
    ]
    if (!isPlaying) {
      timers.push(
        schedule(() => {
          requestThumbnails(generation, range.nearStart, range.visibleStart, 200, "near", batchSize)
          requestThumbnails(generation, range.visibleEnd, range.nearEnd, 200, "near", batchSize)
        }, THUMBNAIL_SCHEDULER.nearDelayMs),
        ...(thumbnailPrefetchAllowed !== false
          ? [schedule(() => {
              requestThumbnails(generation, range.prefetchStart, range.nearStart, 100, "prefetch", batchSize)
              requestThumbnails(generation, range.nearEnd, range.prefetchEnd, 100, "prefetch", batchSize)
            }, THUMBNAIL_SCHEDULER.prefetchDelayMs)]
          : []),
      )
    }

    return () => {
      active = false
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
    thumbnailsAllowed,
    thumbnailRetry,
    videoId,
    lod.intervalSeconds,
    clips,
    sourceDuration,
  ])

  useEffect(() => {
    if (!originalPath || !videoId || !hasAudio || duration <= 0 || range.visibleEnd <= range.visibleStart) return
    const generation = waveformGenerationRef.current
    const chunkSeconds = WAVEFORM_CHUNK_SECONDS
    const cacheOnly = isPlaying || waveformAllowed === false
    // Stable tiles survive zoom changes. Only one neighboring tile is prefetched.
    const chunks = [...new Set(visibleSourceRanges(clips, range.visibleStart, range.visibleEnd).flatMap(([start, end]) => {
      const first = Math.max(0, Math.floor(start / chunkSeconds) - (waveformPrefetch ? 1 : 0))
      const last = Math.min(Math.ceil(sourceDuration / chunkSeconds) - 1, Math.ceil(end / chunkSeconds) - 1 + (waveformPrefetch ? 1 : 0))
      return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
    }))]
    let cancelled = false
    const isCurrent = () => !cancelled && generation === waveformGenerationRef.current
    const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))
    const timeout = window.setTimeout(() => {
      void (async () => {
        // A viewport change reuses an in-flight tile instead of launching duplicates.
        await waveformInFlightRef.current?.catch(() => undefined)
        if (!isCurrent()) return
        let deferred = false
        setWaveformStatus({key: waveformKey, pending: chunks.length, deferred})
        for (let position = 0; position < chunks.length; position++) {
          if (!isCurrent()) return
          const chunk = chunks[position]
          const chunkKey = String(chunk)
          const startTime = chunk * chunkSeconds
          const endTime = Math.min(sourceDuration, startTime + chunkSeconds)
          const peakCount = Math.max(1, Math.min(20_000, Math.ceil((endTime - startTime) / secondsPerPeak)))
          if ((waveformChunksRef.current.get(chunkKey)?.peaks.length ?? 0) >= peakCount) continue
          let waveform: AudioWaveformResult | undefined
          for (let attempt = 0; attempt < (cacheOnly ? 1 : 3); attempt++) {
            if (!isCurrent()) return
            const work = mediaService.generateAudioWaveform({videoId, filePath: originalPath, startTime, endTime, peakCount, cacheOnly})
            waveformInFlightRef.current = work
            try { waveform = await work; break }
            catch { if (!cacheOnly && attempt < 2) await delay(250 * (attempt + 1)) }
            finally { if (waveformInFlightRef.current === work) waveformInFlightRef.current = null }
          }
          if (generation !== waveformGenerationRef.current) return
          if (waveform?.videoId === videoId) {
            const cached = waveformChunksRef.current.get(chunkKey)
            if (!cached || cached.peaks.length <= waveform.peaks.length) {
              waveformChunksRef.current.delete(chunkKey)
              waveformChunksRef.current.set(chunkKey, waveform)
            }
            // Keep a useful overview of long files, bounded by points as well as tiles.
            let points = [...waveformChunksRef.current.values()].reduce((total, entry) => total + entry.peaks.length, 0)
            while (waveformChunksRef.current.size > 4096 || points > 500_000) {
              const oldest = waveformChunksRef.current.keys().next().value
              if (oldest === undefined) break
              points -= waveformChunksRef.current.get(oldest)!.peaks.length
              waveformChunksRef.current.delete(oldest)
            }
            setWaveformCache({key: waveformKey, chunks: [...waveformChunksRef.current.values()]})
          } else { deferred = true }
          if (!isCurrent()) return
          setWaveformStatus({key: waveformKey, pending: chunks.length - position - 1, deferred})
          await delay(cacheOnly ? 0 : waveformDelay)
        }
        if (isCurrent()) setWaveformStatus({key: waveformKey, pending: 0, deferred})
      })().catch(() => { if (isCurrent()) setWaveformStatus({key: waveformKey, pending: 0, deferred: true}) })
    }, cacheOnly ? 0 : Math.max(100, waveformDelay * 2))
    return () => { cancelled = true; window.clearTimeout(timeout) }
  }, [duration, sourceDuration, clips, hasAudio, isPlaying, mediaService, originalPath, range.visibleEnd, range.visibleStart,
    videoId, waveformAllowed, waveformDelay, waveformPrefetch, waveformKey, secondsPerPeak, waveformRetry])

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
        mediaLabel: videoInfo.filename,
        hasVideo: videoInfo.hasVideo,
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
    videoInfo.filename,
    videoInfo.hasVideo,
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
        handle.setAttribute("aria-valuenow", String(time))
        handle.setAttribute("aria-valuetext", formatClock(time))
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

  useEffect(() => () => {
    jobQueue.cancelQueuedBefore(Number.MAX_SAFE_INTEGER)
    jobQueue.setViewport("", 0, 0, 1)
    void mediaService.cancelTimelineThumbnails().catch(() => undefined)
    thumbnailCache.clear()
  }, [jobQueue, mediaService, thumbnailCache])

  const timeFromClientX = useCallback(
    (clientX: number, snap = false, bounds: [number, number] = [0, duration]) => {
      const el = scrollRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const x = clientX - rect.left + el.scrollLeft
      const rawTime = scale.xToTime(x)
      const result = snapToEdges(rawTime, snapEdges, scale.pixelsPerSecond, snap, bounds)
      setSnapGuide(result.edge)
      return result.time
    },
    [duration, scale, snapEdges],
  )

  const movePlayheadFromPointer = useCallback(
    (clientX: number, disableSnap = false) => {
      const time = timeFromClientX(clientX, snapEnabled && !disableSnap)
      playbackClock.set(time)
      onSeek(time, "preview")
    },
    [onSeek, snapEnabled, timeFromClientX],
  )

  const handlePlayheadPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      movePlayheadFromPointer(event.clientX, event.altKey)
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
      movePlayheadFromPointer(event.clientX, event.altKey)
    },
    [movePlayheadFromPointer],
  )

  const trackDrag = useCallback((event: React.PointerEvent, update: (event: PointerEvent) => void, finish: (commit: boolean) => void) => {
    gestureCleanup.current?.()
    let latest: PointerEvent | null = null
    let changed = false
    let active = true
    let frame = 0
    const tick = () => {
      if (!active) return
      const el = scrollRef.current
      if (el && latest) {
        const rect = el.getBoundingClientRect()
        const delta = latest.clientX < rect.left + 24 ? -14 : latest.clientX > rect.right - 24 ? 14 : 0
        const previousScroll = el.scrollLeft
        if (delta) el.scrollLeft += delta
        if (changed || previousScroll !== el.scrollLeft) update(latest)
        changed = false
      }
      frame = requestAnimationFrame(tick)
    }
    const move = (next: PointerEvent) => { if (next.pointerId === event.pointerId) { latest = next; changed = true } }
    const cleanup = (commit: boolean) => {
      if (!active) return
      active = false
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("blur", cancel)
      window.removeEventListener("keydown", key)
      gestureCleanup.current = null
      setSnapGuide(null)
      setDragPreview(null)
      finish(commit)
    }
    const up = (next: PointerEvent) => { if (next.pointerId === event.pointerId) { update(next); cleanup(true) } }
    const cancel = () => cleanup(false)
    const key = (next: KeyboardEvent) => { if (next.key === "Escape") cleanup(false) }
    gestureCleanup.current = cancel
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("blur", cancel)
    window.addEventListener("keydown", key)
    frame = requestAnimationFrame(tick)
  }, [])

  const startRange = useCallback((event: React.PointerEvent) => {
    event.preventDefault(); event.stopPropagation()
    const start = timeFromClientX(event.clientX, snapEnabled && !event.altKey)
    let end = start
    onSelectRange([start, end])
    trackDrag(event, next => {
      end = timeFromClientX(next.clientX, snapEnabled && !next.altKey)
      onSelectRange([Math.min(start, end), Math.max(start, end)])
    }, commit => { if (!commit || Math.abs(start - end) < 0.000001) onSelectRange(null) })
  }, [onSelectRange, snapEnabled, timeFromClientX, trackDrag])

  const startClipDrag = useCallback((event: React.PointerEvent, clip?: TimelineClip, movingRange?: TimeRange) => {
    if (event.button !== 0) return
    if (event.shiftKey || (rangeTool && !movingRange)) { startRange(event); return }
    event.preventDefault(); event.stopPropagation()
    const additive = event.ctrlKey || event.metaKey
    const ids = clip ? selectedClipIds.includes(clip.id) && !additive ? selectedClipIds : [clip.id] : []
    if (clip && (additive || !selectedClipIds.includes(clip.id))) onSelectClip(clip.id, additive)
    if (additive) return
    const start = timeFromClientX(event.clientX)
    const first = movingRange?.[0] ?? Math.min(...clips.filter(c => ids.includes(c.id)).map(c => c.startTime))
    const span = movingRange ? movingRange[1] - movingRange[0] : clips.filter(c => ids.includes(c.id)).reduce((sum, c) => sum + c.endTime - c.startTime, 0)
    const edges = [0, duration, playbackClock.getSnapshot(), ...markers.map(m => m.time), ...clips.filter(c => !ids.includes(c.id)).flatMap(c => [c.startTime, c.endTime])]
    let moved = false, target = first
    trackDrag(event, next => {
      if (!moved && Math.abs(next.clientX - event.clientX) < 4) return
      if (!moved) { moved = true; onEditStart() }
      const raw = timeFromClientX(next.clientX) - start + first
      const snapped = snapToEdges(raw, edges, scale.pixelsPerSecond, snapEnabled && !next.altKey, [0, duration])
      target = snapped.time
      setSnapGuide(snapped.edge)
      setDragPreview({ time: target, span })
    }, commit => {
      if (!commit) return
      if (moved) { if (movingRange) onMoveRange(movingRange, target); else onMoveClips(ids, target) }
      else { if (clip) onSelectClip(clip.id); onSeek(timeFromClientX(event.clientX, snapEnabled && !event.altKey), "precise"); setSnapGuide(null) }
    })
  }, [clips, duration, markers, onEditStart, onMoveClips, onMoveRange, onSeek, onSelectClip, rangeTool, scale.pixelsPerSecond, selectedClipIds, snapEnabled, startRange, timeFromClientX, trackDrag])

  useEffect(() => {
    if (!contextMenu) return
    const previousFocus = document.activeElement as HTMLElement | null
    const menu = document.querySelector<HTMLElement>("[data-timeline-menu]")
    menu?.querySelector<HTMLButtonElement>("button")?.focus()
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest("[data-timeline-menu]")) setContextMenu(null) }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { setContextMenu(null); if (event.key === "Escape") { event.stopPropagation(); previousFocus?.focus() }; return }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
      event.preventDefault(); event.stopPropagation()
      const buttons = [...menu?.querySelectorAll<HTMLButtonElement>("button") ?? []]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus()
    }
    window.addEventListener("pointerdown", close)
    menu?.addEventListener("keydown", key)
    return () => { window.removeEventListener("pointerdown", close); menu?.removeEventListener("keydown", key) }
  }, [contextMenu])

  const handleScrub = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      if (event.shiftKey || rangeTool) { startRange(event); return }
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      const localY = event.clientY - rect.top
      const time = timeFromClientX(event.clientX, snapEnabled && !event.altKey)

      if (localY >= VIDEO_TRACK_TOP && localY <= VIDEO_TRACK_TOP + VIDEO_TRACK_HEIGHT) {
        const clip = clips.find((candidate) => time >= candidate.startTime && time <= candidate.endTime)
        const additive = event.ctrlKey || event.metaKey
        if (clip) {
          onSelectClip(clip.id, additive)
          if (additive) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
        } else {
          const gap = gaps.find(([start, end]) => time >= start && time < end)
          if (gap) { onSelectRange(gap); onSeek(time, "precise"); setSnapGuide(null); return }
        }
      }

      movePlayheadFromPointer(event.clientX, event.altKey)
      let active = true
      let lastScrubTime = time
      const cleanup = () => {
        if (!active) return
        active = false
        onSeek(lastScrubTime, "precise")
        setSnapGuide(null)
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
        lastScrubTime = timeFromClientX(moveEvent.clientX, snapEnabled && !moveEvent.altKey)
        movePlayheadFromPointer(moveEvent.clientX, moveEvent.altKey)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", cleanup)
      window.addEventListener("pointercancel", cleanup)
      window.addEventListener("blur", cleanup)
    },
    [
      clips,
      onSeek,
      onSelectClip,
      movePlayheadFromPointer,
      snapEnabled,
      timeFromClientX,
      gaps, onSelectRange, rangeTool, startRange,
    ],
  )

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (duration <= 0) return
      if (!event.ctrlKey && !event.metaKey && (event.target as HTMLElement).closest("[data-annotation-scroll]")) return
      const el = scrollRef.current
      if (!el) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      if (!event.ctrlKey && !event.metaKey) {
        el.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit
        return
      }

      const rect = el.getBoundingClientRect()
      const next = zoomAroundCursor({
        currentPixelsPerSecond: scale.pixelsPerSecond,
        deltaY: event.deltaY * unit,
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

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener("wheel", handleWheel, {passive: false})
    return () => el.removeEventListener("wheel", handleWheel)
  }, [handleWheel])

  const setTimelineZoom = useCallback((value: number) => {
    const el = scrollRef.current
    if (!el || duration <= 0) return
    const pixelsPerSecond = clamp(value, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND)
    const playheadX = playbackClock.getSnapshot() * scale.pixelsPerSecond - el.scrollLeft
    const anchorX = playheadX >= 0 && playheadX <= el.clientWidth ? playheadX : el.clientWidth / 2
    const anchorTime = (el.scrollLeft + anchorX) / scale.pixelsPerSecond
    userZoomedRef.current = true
    onPxPerSecondChange(pixelsPerSecond)
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, anchorTime * pixelsPerSecond - anchorX)
      scheduleViewportRead()
    })
  }, [duration, onPxPerSecondChange, scale.pixelsPerSecond, scheduleViewportRead])

  const fitTimeline = useCallback(() => {
    const el = scrollRef.current
    if (!el || duration <= 0) return
    userZoomedRef.current = false
    onPxPerSecondChange(clamp(el.clientWidth / duration, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND))
    el.scrollLeft = 0
    scheduleViewportRead()
  }, [duration, onPxPerSecondChange, scheduleViewportRead])

  const dragTrim = useCallback(
    (which: 0 | 1) => (event: React.PointerEvent) => {
      event.stopPropagation()
      onEditStart()
      const move = (moveEvent: PointerEvent) => {
        const time = timeFromClientX(moveEvent.clientX, snapEnabled && !moveEvent.altKey, [0, duration + sourceDuration])
        const next: [number, number] = [...trim]
        if (which === 0) next[0] = Math.min(time, trim[1] - scale.frameDuration)
        else next[1] = Math.max(time, trim[0] + scale.frameDuration)
        onTrimChange(next)
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
    [onEditStart, onTrimChange, scale.frameDuration, snapEnabled, timeFromClientX, trim, duration, sourceDuration],
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
    (annotation: Annotation, mode: "move" | "start" | "end") => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus()
      onSelectAnnotation(annotation.id)
      if (annotation.type === "crop") return
      gestureCleanup.current?.()

      const startTime = annotation.startTime
      const endTime = annotation.endTime
      const span = Math.max(scale.frameDuration, endTime - startTime)
      const pointerStart = timeFromClientX(event.clientX, false)
      const initialX = event.clientX
      let moved = false

      const move = (moveEvent: PointerEvent) => {
        if (!moved) {
          if (Math.abs(moveEvent.clientX - initialX) < 3) return
          moved = true
          onEditStart()
        }
        const pointerTime = timeFromClientX(moveEvent.clientX, snapEnabled && !moveEvent.altKey)
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
        window.removeEventListener("pointercancel", up)
        window.removeEventListener("blur", up)
        window.removeEventListener("keydown", cancel)
        gestureCleanup.current = null
        setSnapGuide(null)
      }
      const cancel = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return
        event.preventDefault(); event.stopPropagation()
        if (moved) onUpdateAnnotation(annotation.id, { startTime, endTime })
        up()
      }
      gestureCleanup.current = up
      window.addEventListener("keydown", cancel)
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", up)
      window.addEventListener("blur", up)
    },
    [duration, onEditStart, onSelectAnnotation, onUpdateAnnotation, scale.frameDuration, snapEnabled, timeFromClientX],
  )

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-border px-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Timeline
        </div>
        <div className="mx-1 h-4 w-px bg-border" />
        {hasAnnotations && <select aria-label="Объект на таймлайне" value={selectedId ?? ""}
          className="max-w-56 rounded-md border border-border bg-card px-2 py-1 text-xs"
          onChange={event => {
            const annotation = annotations.find(a => a.id === event.target.value)
            if (!annotation) return
            onSelectAnnotation(annotation.id)
            onSeek(annotation.startTime, "precise")
            if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, scale.timeToX(annotation.startTime) - 40)
          }}>
          <option value="">Объекты ({annotations.length}) — выбрать…</option>
          {annotations.map(a => <option key={a.id} value={a.id}>{a.visible ? "" : "◌ "}{ANNOTATION_NAMES[a.type]} · {a.label} · {formatClock(a.startTime)}</option>)}
        </select>}
        <button type="button" aria-pressed={rangeTool} onClick={() => setRangeTool(value => !value)}
          title="Выделить произвольный участок перетаскиванием. Также Shift + перетаскивание."
          className={cn("rounded-md px-2 py-1 text-xs", rangeTool ? "bg-primary/20 text-primary" : "text-muted-foreground")}>
          Выделить участок
        </button>
        <button type="button" aria-pressed={rippleDelete} onClick={() => onRippleDeleteChange(!rippleDelete)}
          title="При удалении закрывать разрыв. Shift + Delete использует обратный режим."
          className={cn("rounded-md px-2 py-1 text-xs", rippleDelete ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
          Закрывать разрывы
        </button>
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
          aria-pressed={snapEnabled}
          title="Привязка к краям клипов и маркерам. Alt временно отключает привязку."
          onClick={() => setSnapEnabled((enabled) => !enabled)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent/15",
            snapEnabled ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Magnet className="size-3.5" />
          Snap
        </button>

        <div className="ml-auto flex items-center gap-2">
          {videoInfo.hasVideo === false ? <span className="text-xs text-muted-foreground">Audio waveform</span> : timelineProgress.total > 0 &&
          timelineProgress.ready >= timelineProgress.total ? (
            <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="size-3" />
              Previews ready
            </span>
          ) : timelineProgress.pending > 0 ? (
            <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-[11px] text-primary">
              <LoaderCircle className="size-3 animate-spin" />
              Loading previews {timelineProgress.ready}/{timelineProgress.total}
            </span>
          ) : timelineProgress.total > 0 ? (
            <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground">
              <CircleAlert className="size-3" />
              Previews pending
              <button type="button" className="underline underline-offset-2" onClick={() => setThumbnailRetry(value => value + 1)}>Retry</button>
            </span>
          ) : videoId ? (
            <span className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Preparing timeline
            </span>
          ) : null}
          {hasAudio && waveformStatus.key === waveformKey && (waveformStatus.pending > 0 || waveformStatus.deferred) && (
            <span className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
              {waveformStatus.pending > 0 && <LoaderCircle className="size-3 animate-spin" />}
              {waveformStatus.pending > 0 ? `Waveform: ${waveformStatus.pending} sections remaining` : "Waveform pending"}
              {waveformStatus.pending === 0 && !isPlaying && waveformAllowed !== false && (
                <button type="button" className="underline underline-offset-2" onClick={() => setWaveformRetry(value => value + 1)}>Retry</button>
              )}
            </span>
          )}
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
            title={`Pressure: ${performanceConfig?.pressure ?? "unknown"}; ${performanceConfig?.hardware.logicalCpus ?? "?"} CPU threads; power: ${performanceConfig?.hardware.onBattery === true ? "battery" : performanceConfig?.hardware.onBattery === false ? "plugged in" : "unknown"}`}
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
              <option value="" disabled>Выберите клип</option>
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
                  disabled={clips.length === 0}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Split clip"
                >
                  <Split className="size-3.5" />
                </button>
              }
            />
            <TooltipContent>Split clip at playhead (S)</TooltipContent>
          </Tooltip>
          {(
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onDeleteClip()}
                    disabled={selectedClipIds.length === 0 && !selectedRange}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Delete clip"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                }
              />
              <TooltipContent>Удалить выделенные клипы или участок (Delete / Backspace)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="w-28 shrink-0 border-r border-border bg-sidebar/50" style={{minHeight: timelineHeight}}>
          <div className="flex items-center border-b border-border px-3 text-[10px] uppercase tracking-wider text-muted-foreground/60" style={{height: RULER_HEIGHT}}>Tracks</div>
          {tracks.map((track) => {
            const Icon = track.icon
            return (
              <div
                key={track.id}
                className="flex items-center gap-2 border-b border-border/50 px-3 text-xs text-muted-foreground"
                style={{height: track.height}}
              >
                {track.id !== "annotations" && <Icon className={cn("size-3.5 shrink-0", track.id === "audio" ? "text-emerald-300/80" : "text-sky-300/80")} />}
                <div className="min-w-0"><span className="block truncate">{track.label}</span>
                  {track.id === "annotations" && <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/70">{annotations.length} объектов<br />Колесо — строки<br />Края — время</span>}
                </div>
              </div>
            )
          })}
        </div>

        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          style={{minHeight: timelineHeight}}
          onScroll={scheduleViewportRead}
        >
          <div className="relative h-full" style={{ width }}>
            <div
              className="sticky left-0 top-0 h-full"
              style={{ width: viewport.width }}
              onPointerDown={handleScrub}
              onContextMenu={event => {
                event.preventDefault()
                const time = timeFromClientX(event.clientX)
                const clip = clips.find(c => time >= c.startTime && time < c.endTime)
                if (clip && !selectedClipIds.includes(clip.id)) onSelectClip(clip.id)
                else if (!clip) onSelectRange(gaps.find(([a, b]) => time >= a && time < b) ?? null)
                setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 160) })
              }}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 block h-full"
                style={{ width: viewport.width, height: "100%" }}
              />
              <canvas
                ref={playheadCanvasRef}
                className="pointer-events-none absolute inset-0 z-30 block h-full"
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
                className="group/playhead absolute left-0 top-0 z-40 w-5 cursor-col-resize touch-none select-none"
                style={{ height: RULER_HEIGHT }}
                onPointerDown={handlePlayheadPointerDown}
                onPointerMove={handlePlayheadPointerMove}
                onPointerUp={(event) => {
                  event.stopPropagation()
                  onSeek(playbackClock.getSnapshot(), "precise")
                  setSnapGuide(null)
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
                onPointerCancel={(event) => {
                  onSeek(playbackClock.getSnapshot(), "precise")
                  setSnapGuide(null)
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.ctrlKey || event.metaKey || event.altKey) return
                  const delta = event.shiftKey ? 10 : 1
                  const target = event.key === "Home" ? 0 : event.key === "End" ? duration
                    : event.key === "ArrowLeft" ? playbackClock.getSnapshot() - delta
                    : event.key === "ArrowRight" ? playbackClock.getSnapshot() + delta : null
                  if (target === null) return
                  event.preventDefault(); event.stopPropagation()
                  const time = clamp(target, 0, duration)
                  playbackClock.set(time); onSeek(time, "precise")
                }}
              >
                <div className="pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-rose-400/0 transition-colors group-hover/playhead:bg-rose-400/25" />
              </div>
            </div>
            {clips.filter(clip => clip.endTime >= range.visibleStart && clip.startTime <= range.visibleEnd).map(clip => (
              <button key={clip.id} type="button" aria-label={`Клип ${clip.label}`} aria-pressed={selectedClipIds.includes(clip.id)}
                title={`${clip.label} · ${ (clip.endTime - clip.startTime).toFixed(2) } с · исходник ${sourceStart(clip).toFixed(2)} с. Перетащите для переноса; Ctrl — выбор нескольких; Shift — выделение участка.`}
                onPointerDown={event => startClipDrag(event, clip)}
                onContextMenu={event => { event.preventDefault(); if (!selectedClipIds.includes(clip.id)) onSelectClip(clip.id); setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 160) }) }}
                onKeyDown={event => { if (event.key === "Enter") { onSelectClip(clip.id, event.ctrlKey || event.metaKey); onSeek(clip.startTime, "precise") } }}
                className="absolute z-10 cursor-grab rounded-md border border-transparent bg-transparent focus-visible:outline-2 focus-visible:outline-sky-300 active:cursor-grabbing"
                style={{ left: scale.timeToX(clip.startTime), top: VIDEO_TRACK_TOP, width: Math.max(1, (clip.endTime - clip.startTime) * scale.pixelsPerSecond), height: VIDEO_TRACK_HEIGHT }} />
            ))}
            {selectedRange && <div className="absolute z-20 cursor-grab border-x-2 border-sky-300 bg-sky-400/20 active:cursor-grabbing"
              aria-label="Выделенный участок" title="Перетащите участок для переноса; Delete — удалить; Esc — снять выделение."
              onPointerDown={event => startClipDrag(event, undefined, selectedRange)}
              onContextMenu={event => { event.preventDefault(); setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 160) }) }}
              style={{ left: scale.timeToX(selectedRange[0]), width: Math.max(1, (selectedRange[1] - selectedRange[0]) * scale.pixelsPerSecond), top: RULER_HEIGHT, bottom: 0 }} />}
            {snapGuide !== null && <div className="pointer-events-none absolute inset-y-0 z-40 w-px bg-amber-300" style={{ left: scale.timeToX(snapGuide) }} />}
            {dragPreview && <div className="pointer-events-none absolute z-30 rounded border-2 border-sky-300 bg-sky-400/25"
              style={{ left: scale.timeToX(dragPreview.time), width: dragPreview.span * scale.pixelsPerSecond, top: VIDEO_TRACK_TOP, height: VIDEO_TRACK_HEIGHT }}>
              <span className="rounded bg-slate-900 px-1 text-xs text-white">Вставить {dragPreview.time.toFixed(2)} с</span>
            </div>}
            {hasAnnotations && <div ref={annotationScrollRef} data-annotation-scroll
              aria-label="Дорожки объектов" className="absolute z-20 overflow-x-hidden overflow-y-auto overscroll-contain rounded border border-border/50"
              style={{ left: viewport.scrollLeft, top: ANNOTATION_TRACK_TOP, width: viewport.width, height: ANNOTATION_TRACK_HEIGHT }}
              onScroll={event => setAnnotationScrollTop(event.currentTarget.scrollTop)}>
              <div className="relative" style={{ height: annotationContentHeight }}>
            {annotations.filter(annotation => {
              const top = annotationLaneTop(annotationLanes.get(annotation.id) ?? 0)
              return annotation.endTime + 28 / scale.pixelsPerSecond >= range.visibleStart && annotation.startTime <= range.visibleEnd
                && top + ANNOTATION_LANE_HEIGHT >= annotationViewportTop && top < annotationViewportTop + ANNOTATION_TRACK_HEIGHT
            }).map((annotation) => {
              const left = scale.timeToX(annotation.startTime) - viewport.scrollLeft
              const annotationWidth = Math.max(28, (annotation.endTime - annotation.startTime) * scale.pixelsPerSecond)
              const isSelected = annotation.id === selectedId
              const lane = annotationLanes.get(annotation.id) ?? 0
              const Icon = annotationIcons[annotation.type]
              return (
                <div
                  key={annotation.id}
                  data-annotation-id={annotation.id}
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
                    aria-pressed={isSelected}
                    title={`${ANNOTATION_NAMES[annotation.type]} · ${annotation.label}\n${formatTimecode(annotation.startTime, videoInfo.fps)} → ${formatTimecode(annotation.endTime, videoInfo.fps)}${annotation.visible ? "" : " · Скрыт"}\nНажмите для свойств; перетащите для переноса; края — длительность; Delete — удалить.`}
                    onPointerDown={dragAnnotationTime(annotation, "move")}
                    onClick={() => onSelectAnnotation(annotation.id)}
                    style={{ borderLeftColor: annotation.color, opacity: annotation.visible ? 1 : 0.5 }}
                    className={cn(
                      "absolute inset-0 flex cursor-grab items-center gap-1.5 overflow-hidden rounded border border-l-4 px-2 text-xs text-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-primary",
                      isSelected
                        ? "border-primary bg-primary/25"
                        : "border-border bg-secondary hover:border-primary/60",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{ANNOTATION_NAMES[annotation.type]} · {annotation.label}</span>
                    {!annotation.visible && <EyeOff className="size-3 shrink-0" />}
                  </button>
                  {annotation.type !== "crop" && isSelected && <><button
                    type="button"
                    aria-label={`Resize ${annotation.label} start`}
                    onPointerDown={dragAnnotationTime(annotation, "start")}
                    tabIndex={-1}
                    className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize rounded-l-sm bg-primary/40 hover:bg-primary"
                  />
                  <button
                    type="button"
                    aria-label={`Resize ${annotation.label} end`}
                    onPointerDown={dragAnnotationTime(annotation, "end")}
                    tabIndex={-1}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r-sm bg-primary/40 hover:bg-primary"
                  /></>}
                </div>
              )
            })}
              </div>
            </div>}
            {selectedClipId && <button type="button"
              className="absolute z-30 cursor-ew-resize"
              style={{
                left: scale.timeToX(trim[0]) - 5,
                top: VIDEO_TRACK_TOP,
                width: 10,
                height: VIDEO_TRACK_HEIGHT,
              }}
              onPointerDown={dragTrim(0)}
              onKeyDown={event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault(); event.stopPropagation()
                onTrimChange([trim[0] + (event.key === "ArrowLeft" ? -1 : 1) * scale.frameDuration, trim[1]])
              }}
              aria-label="Trim start"
            />}
            {selectedClipId && <button type="button"
              className="absolute z-30 cursor-ew-resize"
              style={{
                left: scale.timeToX(trim[1]) - 5,
                top: VIDEO_TRACK_TOP,
                width: 10,
                height: VIDEO_TRACK_HEIGHT,
              }}
              onPointerDown={dragTrim(1)}
              onKeyDown={event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault(); event.stopPropagation()
                onTrimChange([trim[0], trim[1] + (event.key === "ArrowLeft" ? -1 : 1) * scale.frameDuration])
              }}
              aria-label="Trim end"
            />}
          </div>
        </div>
      </div>
      {contextMenu && <div data-timeline-menu role="menu" className="fixed z-50 grid w-56 gap-1 rounded-md border border-border bg-popover p-1 text-sm shadow-xl" style={{ left: contextMenu.x, top: contextMenu.y }}>
        <button role="menuitem" className="rounded px-3 py-2 text-left hover:bg-accent" onClick={() => { onSplitClip(); setContextMenu(null) }}>Разрезать у курсора · S</button>
        <button role="menuitem" className="rounded px-3 py-2 text-left hover:bg-accent" onClick={() => { onDeleteClip(true); setContextMenu(null) }}>Удалить и закрыть разрыв</button>
        <button role="menuitem" className="rounded px-3 py-2 text-left hover:bg-accent" onClick={() => { onDeleteClip(false); setContextMenu(null) }}>Удалить, оставив разрыв</button>
      </div>}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-sidebar/40 px-3">
        {selectedRange && <span className="text-xs text-sky-300">Участок: {selectedRange[0].toFixed(2)}–{selectedRange[1].toFixed(2)} с · Delete</span>}
        <span className="min-w-0 truncate font-mono text-[10px] tabular-nums text-muted-foreground" title="Visible time range">
          {formatClock(range.visibleStart)} — {formatClock(range.visibleEnd)}
        </span>
          <span className="hidden text-[10px] text-muted-foreground/60 xl:inline" title="S / Ctrl+B — разрезать; Shift + перетаскивание — участок; Ctrl + клик — несколько клипов; Delete — удалить; Ctrl+Z — отмена; Alt — без привязки.">Shift + drag — участок · Ctrl + scroll — масштаб</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" onClick={fitTimeline} disabled={duration <= 0} aria-label="Fit timeline" title="Fit entire timeline" className="flex h-6 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-accent/20 hover:text-foreground disabled:opacity-40"><Maximize2 className="size-3.5" />Fit</button>
          <button type="button" onClick={() => setTimelineZoom(scale.pixelsPerSecond / 1.5)} disabled={scale.pixelsPerSecond <= MIN_PIXELS_PER_SECOND} aria-label="Zoom out timeline" className="rounded p-1 text-muted-foreground hover:bg-accent/20 hover:text-foreground disabled:opacity-40"><ZoomOut className="size-3.5" /></button>
          <input type="range" min={0} max={1000} step={1}
            value={Math.round(Math.log(scale.pixelsPerSecond / MIN_PIXELS_PER_SECOND) / Math.log(MAX_PIXELS_PER_SECOND / MIN_PIXELS_PER_SECOND) * 1000)}
            onChange={event => setTimelineZoom(MIN_PIXELS_PER_SECOND * (MAX_PIXELS_PER_SECOND / MIN_PIXELS_PER_SECOND) ** (Number(event.currentTarget.value) / 1000))}
            aria-label="Timeline zoom" className="h-1 w-24 accent-sky-300 sm:w-32" />
          <button type="button" onClick={() => setTimelineZoom(scale.pixelsPerSecond * 1.5)} disabled={scale.pixelsPerSecond >= MAX_PIXELS_PER_SECOND} aria-label="Zoom in timeline" className="rounded p-1 text-muted-foreground hover:bg-accent/20 hover:text-foreground disabled:opacity-40"><ZoomIn className="size-3.5" /></button>
        </div>
      </div>
    </div>
  )
}
