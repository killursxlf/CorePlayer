import type { Annotation, TimelineClip, TimelineMarker } from "@/lib/editor-types"
import { clipAt, sourceTime } from "@/lib/timeline-edit"
import type { AudioWaveformResult, ThumbnailState } from "@/types/media"
import type { LodSelection } from "./lod-selector"
import type { ThumbnailCache } from "./thumbnail-cache"
import type { TimelineScale } from "./timeline-scale"
import type { VisibleRange } from "./visible-range"
import { RULER_HEIGHT, VIDEO_TRACK_TOP, VIDEO_TRACK_HEIGHT, audioTrackTop, subtitleTrackTop } from "./timeline-layout"
import {
  ANNOTATION_LANE_HEIGHT,
  ANNOTATION_TRACK_HEIGHT,
  ANNOTATION_TRACK_TOP,
  annotationLaneTop,
  assignAnnotationLanes,
} from "./annotation-lanes"

export type TimelineRenderModel = {
  duration: number
  currentTime: number
  trim: [number, number]
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  markers: TimelineMarker[]
  annotations: Annotation[]
  selectedId: string | null
  hasAudio: boolean
  hasSubtitles: boolean
  audioPeaks: AudioWaveformResult[]
  videoId: string
  range: VisibleRange
  scale: TimelineScale
  lod: LodSelection
  cache: ThumbnailCache
  states: Map<string, ThumbnailState>
  mediaLabel?: string
  hasVideo?: boolean
}

const colors = {
  background: "#11131a",
  panel: "#171a23",
  border: "rgba(255,255,255,0.12)",
  text: "rgba(236,240,248,0.72)",
  faint: "rgba(236,240,248,0.22)",
  primary: "#7dd3fc",
  destructive: "#fb7185",
  audio: "#86efac",
  annotation: "#f0abfc",
}

export function renderTimelineCanvas(canvas: HTMLCanvasElement, model: TimelineRenderModel) {
  const context = canvas.getContext("2d")
  if (!context) return

  const dpr = window.devicePixelRatio || 1
  const cssWidth = Math.max(1, model.range.viewportWidth)
  const cssHeight = Math.max(1, canvas.clientHeight)
  const targetWidth = Math.floor(cssWidth * dpr)
  const targetHeight = Math.floor(cssHeight * dpr)
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, cssWidth, cssHeight)
  context.fillStyle = colors.background
  context.fillRect(0, 0, cssWidth, cssHeight)

  drawRuler(context, model, cssWidth)
  drawVideoTrack(context, model, cssWidth)
  drawAnnotations(context, model)
  if (model.hasAudio) drawAudio(context, model, cssWidth)
  if (model.hasSubtitles) drawSubtitles(context, cssWidth, subtitleTrackTop(model.annotations.length > 0, model.hasAudio))
}

export function renderTimelinePlayhead(canvas: HTMLCanvasElement, model: TimelineRenderModel) {
  const context = canvas.getContext("2d")
  if (!context) return
  const dpr = window.devicePixelRatio || 1
  const cssWidth = Math.max(1, model.range.viewportWidth)
  const cssHeight = Math.max(1, canvas.clientHeight)
  const targetWidth = Math.floor(cssWidth * dpr)
  const targetHeight = Math.floor(cssHeight * dpr)
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, cssWidth, cssHeight)
  drawPlayhead(context, model, cssHeight)
}

function screenX(model: TimelineRenderModel, time: number) {
  return model.scale.timeToX(time) - model.range.scrollLeft
}

function rulerLabel(time: number, interval: number) {
  const milliseconds = Math.round(time * 1000)
  const wholeSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor(wholeSeconds / 60) % 60
  const seconds = wholeSeconds % 60
  const clock = (hours ? String(hours).padStart(2, "0") + ":" : "") + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
  return interval < 1 ? clock + "." + String(milliseconds % 1000).padStart(3, "0") : clock
}

function drawRuler(context: CanvasRenderingContext2D, model: TimelineRenderModel, width: number) {
  context.fillStyle = "#151821"
  context.fillRect(0, 0, width, RULER_HEIGHT)
  const target = 96 / model.scale.pixelsPerSecond
  const steps = [.05, .1, .25, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400]
  const interval = steps.find(step => step >= target) ?? 3600 * Math.ceil(target / 3600)
  const minor = model.lod.showFrameTicks ? model.scale.frameDuration : interval / 4
  context.strokeStyle = colors.faint
  context.beginPath()
  for (let index = Math.floor(model.range.visibleStart / minor); index * minor <= model.range.visibleEnd; index++) {
    const x = Math.round(screenX(model, index * minor)) + .5
    context.moveTo(x, RULER_HEIGHT - 5)
    context.lineTo(x, RULER_HEIGHT)
  }
  context.stroke()
  context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.textBaseline = "top"
  for (let index = Math.floor(model.range.visibleStart / interval); index * interval <= model.range.visibleEnd; index++) {
    const time = index * interval
    const x = Math.round(screenX(model, time)) + .5
    context.strokeStyle = colors.text
    context.beginPath(); context.moveTo(x, RULER_HEIGHT - 9); context.lineTo(x, RULER_HEIGHT); context.stroke()
    context.fillStyle = colors.text
    context.fillText(rulerLabel(time, interval), x + 5, 7)
  }
  context.strokeStyle = colors.border
  context.beginPath(); context.moveTo(0, RULER_HEIGHT - .5); context.lineTo(width, RULER_HEIGHT - .5); context.stroke()
  for (const marker of model.markers) {
    const x = screenX(model, marker.time)
    if (x < -10 || x > width + 10) continue
    context.fillStyle = marker.color
    context.beginPath(); context.moveTo(x, 20); context.lineTo(x + 5, 26); context.lineTo(x, 32); context.lineTo(x - 5, 26); context.closePath(); context.fill()
  }
}

function drawImageCover(context: CanvasRenderingContext2D, bitmap: ImageBitmap, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / bitmap.width, height / bitmap.height)
  const sourceWidth = width / scale
  const sourceHeight = height / scale
  context.drawImage(bitmap, (bitmap.width - sourceWidth) / 2, (bitmap.height - sourceHeight) / 2, sourceWidth, sourceHeight, x, y, width, height)
}

function drawVideoTrack(context: CanvasRenderingContext2D, model: TimelineRenderModel, width: number) {
  const top = VIDEO_TRACK_TOP
  const height = VIDEO_TRACK_HEIGHT
  const interval = model.lod.intervalSeconds
  const cellWidth = interval * model.scale.pixelsPerSecond
  drawTrackBackground(context, top, height, width)
  for (const clip of model.clips) {
    const left = screenX(model, clip.startTime)
    const right = screenX(model, clip.endTime)
    if (right <= 0 || left >= width || right <= left) continue
    const selected = clip.id === model.selectedClipId || model.selectedClipIds.includes(clip.id)
    context.save()
    roundedRect(context, left + 1, top, Math.max(1, right - left - 2), height, 6)
    context.clip()
    context.fillStyle = model.hasVideo === false ? "#17352e" : "#253043"
    context.fillRect(Math.max(0, left), top, Math.min(width, right) - Math.max(0, left), height)
    if (model.hasVideo !== false) {
      const first = Math.floor(Math.max(clip.startTime, model.range.visibleStart) / interval)
      const last = Math.ceil(Math.min(clip.endTime, model.range.visibleEnd) / interval)
      for (let index = first; index < last; index++) {
        const time = index * interval
        const x = screenX(model, time)
        const source = Math.max(0, sourceTime(clip, Math.max(clip.startTime, time)))
        const sample = Math.floor(source / interval) * interval
        const exact = model.cache.getAtTimestamp(model.videoId, sample)
        const image = exact ?? model.cache.findNearest(model.videoId, interval, sample, interval)
        if (image) {
          drawImageCover(context, image.bitmap, x, top + 20, cellWidth + .5, height - 20)
          if (!exact) {
            context.fillStyle = "rgba(16,24,39,.18)"
            context.fillRect(x, top + 20, cellWidth + .5, height - 20)
          }
        } else drawLoadingSlot(context, model, x, top + 20, cellWidth + .5, height - 20, sample)
      }
    }
    context.fillStyle = selected ? "#21506b" : "#293445"
    context.fillRect(left, top, right - left, 20)
    if (right - left > 45) {
      const labelX = Math.max(left + 8, 8)
      context.save(); context.beginPath(); context.rect(labelX, top, Math.max(0, Math.min(width, right) - labelX - 8), 20); context.clip()
      context.font = "11px ui-sans-serif, system-ui"; context.textBaseline = "middle"
      context.fillStyle = selected ? "#e0f5ff" : "#d4dce8"
      const label = model.clips.length === 1 ? model.mediaLabel ?? clip.label : clip.label
      context.fillText(label, labelX, top + 10)
      context.restore()
    }
    context.restore()
    context.strokeStyle = selected ? "#7dd3fc" : "rgba(211,224,242,.25)"
    context.lineWidth = selected ? 2 : 1
    roundedRect(context, left + 1, top + .5, Math.max(1, right - left - 2), height - 1, 6); context.stroke()
    context.lineWidth = 1
  }
  for (const time of model.selectedClipId ? model.trim : []) {
    const x = screenX(model, time)
    if (x < -5 || x > width + 5) continue
    context.fillStyle = colors.primary
    roundedRect(context, x - 2, top + 2, 4, height - 4, 2); context.fill()
  }
}

function drawLoadingSlot(
  context: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  x: number,
  y: number,
  width: number,
  height: number,
  time: number,
) {
  const key = `${model.videoId}:${Math.round(model.lod.intervalSeconds * 1000)}:${Math.round(time * 1000)}`
  const state = model.states.get(key) ?? "missing"
  const gradient = context.createLinearGradient(x, y, x + width, y + height)
  gradient.addColorStop(0, "#273044")
  gradient.addColorStop(0.5, "#31384d")
  gradient.addColorStop(1, "#242b3c")
  context.fillStyle = gradient
  context.fillRect(x, y, width, height)
  context.strokeStyle = "rgba(255,255,255,0.08)"
  context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1)

  if (state === "queued" || state === "loading") {
    context.fillStyle = "rgba(255,255,255,0.12)"
    context.fillRect(x + 4, y + height - 5, Math.max(4, width - 8), 1)
  }
}

function drawAnnotations(context: CanvasRenderingContext2D, model: TimelineRenderModel) {
  if (model.annotations.length === 0) return
  drawTrackBackground(context, ANNOTATION_TRACK_TOP, ANNOTATION_TRACK_HEIGHT, model.range.viewportWidth)
  const lanes = assignAnnotationLanes(model.annotations)

  for (const annotation of model.annotations) {
    const x = screenX(model, annotation.startTime)
    const width = Math.max(28, (annotation.endTime - annotation.startTime) * model.scale.pixelsPerSecond)
    const lane = lanes.get(annotation.id) ?? 0
    const y = annotationLaneTop(lane)
    context.fillStyle = annotation.id === model.selectedId ? "rgba(240,171,252,0.32)" : "rgba(240,171,252,0.16)"
    context.strokeStyle = colors.annotation
    roundedRect(context, x, y, width, ANNOTATION_LANE_HEIGHT, 4)
    context.fill()
    context.stroke()
    context.fillStyle = colors.text
    context.font = "9px ui-sans-serif, system-ui"
    if (width > 34) context.fillText(annotation.label, x + 6, y + 1)
  }
}

function drawAudio(context: CanvasRenderingContext2D, model: TimelineRenderModel, width: number) {
  const top = audioTrackTop(model.annotations.length > 0)
  const height = 48
  drawTrackBackground(context, top, height, width)

  const contentStartX = screenX(model, 0)
  const contentEndX = screenX(model, model.duration)
  const centerY = top + height / 2
  const minPixelStep = 3
  const timeStep = Math.max(0.005, minPixelStep / model.scale.pixelsPerSecond)
  const barWidth = Math.max(1, Math.min(3, timeStep * model.scale.pixelsPerSecond * 0.65))
  const start = Math.max(0, Math.floor(model.range.visibleStart / timeStep) * timeStep)
  const end = Math.min(model.duration, model.range.visibleEnd + timeStep)

  context.save()
  context.beginPath()
  context.rect(contentStartX, top + 5, Math.max(0, contentEndX - contentStartX), height - 10)
  context.clip()

  if (model.audioPeaks.length === 0) {
    context.restore()
    return
  }

  context.fillStyle = colors.audio
  for (let time = start; time <= end; time += timeStep) {
    const x = screenX(model, time)
    if (x > width + barWidth || x + barWidth < -barWidth) continue

    const clip = clipAt(model.clips, time)
    if (!clip) continue
    const energy = audioPeakAtTime(model, sourceTime(clip, time), sourceTime(clip, Math.min(clip.endTime, time + timeStep)))
    if (energy === null) continue
    // RMS values are naturally concentrated near zero. A square-root display
    // curve reveals useful loudness differences without changing cached audio.
    const visualEnergy = Math.sqrt(Math.max(0, Math.min(1, energy)))
    const barHeight = Math.max(2, visualEnergy * (height - 10))
    context.fillRect(x, centerY - barHeight / 2, barWidth, barHeight)
  }
  context.restore()
}

function audioPeakAtTime(model: TimelineRenderModel, time: number, end: number): number | null {
  // Chunks are sorted once when the cache changes, instead of scanning every
  // cached tile for every bar. Average energy when reusing a finer zoom level.
  let low = 0
  let high = model.audioPeaks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (model.audioPeaks[middle].endTime <= time) low = middle + 1
    else high = middle
  }
  let energy = 0
  let covered = 0
  for (let tile = low; tile < model.audioPeaks.length; tile++) {
    const chunk = model.audioPeaks[tile]
    if (chunk.startTime >= end) break
    if (!chunk.peaks.length || chunk.endTime <= chunk.startTime) continue
    const step = (chunk.endTime - chunk.startTime) / chunk.peaks.length
    const first = Math.max(0, Math.floor((time - chunk.startTime) / step))
    const last = Math.min(chunk.peaks.length, Math.ceil((end - chunk.startTime) / step))
    for (let index = first; index < last; index++) {
      const overlap = Math.max(0, Math.min(end, chunk.startTime + (index + 1) * step) - Math.max(time, chunk.startTime + index * step))
      energy += chunk.peaks[index] ** 2 * overlap
      covered += overlap
    }
  }
  return covered > 0 ? Math.sqrt(energy / covered) : null
}

function drawSubtitles(context: CanvasRenderingContext2D, width: number, top: number) {
  drawTrackBackground(context, top, 32, width)
  context.fillStyle = colors.text
  context.font = "11px ui-sans-serif, system-ui"
  context.fillText("Subtitles", 12, top + 12)
}

function drawPlayhead(context: CanvasRenderingContext2D, model: TimelineRenderModel, height: number) {
  const x = screenX(model, model.currentTime)
  context.strokeStyle = colors.destructive
  context.beginPath()
  context.moveTo(x + 0.5, 0)
  context.lineTo(x + 0.5, height)
  context.stroke()
  context.fillStyle = colors.destructive
  context.beginPath()
  context.moveTo(x - 7, 0)
  context.lineTo(x + 7, 0)
  context.lineTo(x, 10)
  context.closePath()
  context.fill()
}

function drawTrackBackground(context: CanvasRenderingContext2D, top: number, height: number, width: number) {
  context.fillStyle = colors.panel
  context.fillRect(0, top, width, height)
  context.strokeStyle = colors.border
  context.beginPath()
  context.moveTo(0, top + height + 0.5)
  context.lineTo(width, top + height + 0.5)
  context.stroke()
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}
