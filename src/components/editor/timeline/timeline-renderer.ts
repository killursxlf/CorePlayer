import type { Annotation, TimelineClip, TimelineMarker } from "@/lib/editor-types"
import { formatClock } from "@/lib/editor-types"
import type { ThumbnailState } from "@/types/media"
import type { LodSelection } from "./lod-selector"
import { alignTimeToLod } from "./lod-selector"
import type { ThumbnailCache } from "./thumbnail-cache"
import type { TimelineScale } from "./timeline-scale"
import type { VisibleRange } from "./visible-range"
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
  audioPeaks: number[]
  videoId: string
  range: VisibleRange
  scale: TimelineScale
  lod: LodSelection
  cache: ThumbnailCache
  states: Map<string, ThumbnailState>
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
  if (model.hasSubtitles) drawSubtitles(context, cssWidth)
  drawPlayhead(context, model, cssHeight)
}

function screenX(model: TimelineRenderModel, time: number) {
  return model.scale.timeToX(time) - model.range.scrollLeft
}

function drawRuler(context: CanvasRenderingContext2D, model: TimelineRenderModel, width: number) {
  context.fillStyle = "#151821"
  context.fillRect(0, 0, width, 28)
  context.strokeStyle = colors.border
  context.beginPath()
  context.moveTo(0, 27.5)
  context.lineTo(width, 27.5)
  context.stroke()

  const target = 80 / model.scale.pixelsPerSecond
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const interval = steps.find((step) => step >= target) ?? 600
  const start = alignTimeToLod(model.range.visibleStart, interval)

  context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"
  context.textBaseline = "top"
  for (let time = start; time <= model.range.visibleEnd + interval; time += interval) {
    const x = screenX(model, time)
    context.strokeStyle = colors.border
    context.beginPath()
    context.moveTo(x + 0.5, 0)
    context.lineTo(x + 0.5, 9)
    context.stroke()
    context.fillStyle = colors.text
    context.fillText(formatClock(time), x + 4, 11)
  }

  if (model.lod.showFrameTicks) {
    const frameStart = Math.floor(model.range.visibleStart / model.scale.frameDuration)
    const frameEnd = Math.ceil(model.range.visibleEnd / model.scale.frameDuration)
    context.strokeStyle = colors.faint
    context.beginPath()
    for (let frame = frameStart; frame <= frameEnd; frame += 1) {
      const x = screenX(model, frame * model.scale.frameDuration)
      context.moveTo(x + 0.5, 18)
      context.lineTo(x + 0.5, 27)
    }
    context.stroke()
  }

  for (const marker of model.markers) {
    const x = screenX(model, marker.time)
    if (x < -20 || x > width + 20) continue
    context.fillStyle = marker.color
    context.beginPath()
    context.moveTo(x, 15)
    context.lineTo(x + 6, 23)
    context.lineTo(x, 28)
    context.lineTo(x - 6, 23)
    context.closePath()
    context.fill()
  }
}

function drawVideoTrack(context: CanvasRenderingContext2D, model: TimelineRenderModel, width: number) {
  const top = 34
  const height = 40
  drawTrackBackground(context, top, height, width)

  const contentStartX = screenX(model, 0)
  const contentEndX = screenX(model, model.duration)
  const showClipEditing = !isImplicitFullTimelineClip(model)
  const trimStart = Math.max(0, Math.min(model.duration, model.trim[0]))
  const trimEnd = Math.max(trimStart, Math.min(model.duration, model.trim[1]))
  const trimX = screenX(model, trimStart)
  const trimWidth = Math.max(0, (trimEnd - trimStart) * model.scale.pixelsPerSecond)
  if (showClipEditing) {
    context.fillStyle = "rgba(125,211,252,0.12)"
    context.strokeStyle = "rgba(125,211,252,0.55)"
    roundedRect(context, trimX, top + 4, trimWidth, height - 8, 5)
    context.fill()
    context.stroke()
  }

  const interval = model.lod.intervalSeconds
  const start = alignTimeToLod(model.range.requestStart, interval)

  context.save()
  context.beginPath()
  context.rect(contentStartX, top + 5, Math.max(0, contentEndX - contentStartX), height - 10)
  context.clip()

  for (let time = start; time < model.duration && time <= model.range.requestEnd + interval; time += interval) {
    const x = screenX(model, time)
    const slotEnd = Math.min(model.duration, time + interval)
    const slotWidth = Math.max(0, (slotEnd - time) * model.scale.pixelsPerSecond)
    if (slotWidth <= 0 || x > width + slotWidth || x + slotWidth < -slotWidth) continue

    const exact = model.cache.get(model.videoId, interval, Math.round(time * 1000) / 1000)
    const fallback = exact ?? model.cache.findNearest(model.videoId, time, interval * 2.25)
    if (fallback) {
      context.drawImage(fallback.bitmap, x, top + 5, slotWidth, height - 10)
    } else {
      drawLoadingSlot(context, model, x, top + 5, slotWidth, height - 10, time)
    }
  }
  context.restore()

  if (showClipEditing) drawClipBoundaries(context, model, top, height, width)

  if (showClipEditing) {
    context.fillStyle = colors.primary
    context.fillRect(trimX, top + 4, 4, height - 8)
    context.fillRect(Math.max(trimX, trimX + trimWidth - 4), top + 4, 4, height - 8)
  }
}

function isImplicitFullTimelineClip(model: TimelineRenderModel) {
  if (model.clips.length !== 1 || model.duration <= 0) return false
  const [clip] = model.clips
  return Math.abs(clip.startTime) < 0.001 && Math.abs(clip.endTime - model.duration) < 0.001
}

function drawClipBoundaries(
  context: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  top: number,
  height: number,
  viewportWidth: number,
) {
  context.font = "10px ui-sans-serif, system-ui"
  context.textBaseline = "top"

  for (const clip of model.clips) {
    const x = screenX(model, clip.startTime)
    const w = Math.max(1, (clip.endTime - clip.startTime) * model.scale.pixelsPerSecond)
    if (x > viewportWidth + 20 || x + w < -20) continue

    const selected = clip.id === model.selectedClipId || model.selectedClipIds.includes(clip.id)
    context.strokeStyle = selected ? "rgba(125,211,252,0.95)" : "rgba(255,255,255,0.28)"
    context.lineWidth = selected ? 2 : 1
    roundedRect(context, x, top + 4, w, height - 8, 5)
    context.stroke()

    context.fillStyle = selected ? "rgba(125,211,252,0.16)" : "rgba(255,255,255,0.05)"
    roundedRect(context, x, top + 4, w, height - 8, 5)
    context.fill()

    context.fillStyle = selected ? colors.primary : colors.text
    if (w > 42) {
      context.fillText(clip.label, x + 7, top + 8)
    }

    context.strokeStyle = selected ? colors.primary : "rgba(255,255,255,0.45)"
    context.beginPath()
    context.moveTo(x + 0.5, top + 4)
    context.lineTo(x + 0.5, top + height - 4)
    context.moveTo(x + w + 0.5, top + 4)
    context.lineTo(x + w + 0.5, top + height - 4)
    context.stroke()
  }

  context.lineWidth = 1
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
  const top = model.annotations.length > 0 ? 122 : 78
  const height = 40
  drawTrackBackground(context, top, height, width)

  const contentStartX = screenX(model, 0)
  const contentEndX = screenX(model, model.duration)
  const centerY = top + height / 2
  const minPixelStep = 3
  const timeStep = Math.max(model.scale.frameDuration, minPixelStep / model.scale.pixelsPerSecond)
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

    const energy = audioPeakAtTime(model, time)
    const barHeight = Math.max(2, energy * (height - 10))
    context.fillRect(x, centerY - barHeight / 2, barWidth, barHeight)
  }
  context.restore()
}

function audioPeakAtTime(model: TimelineRenderModel, time: number) {
  if (model.duration <= 0 || model.audioPeaks.length === 0) return 0
  const index = Math.min(
    model.audioPeaks.length - 1,
    Math.max(0, Math.floor((time / model.duration) * model.audioPeaks.length)),
  )
  return model.audioPeaks[index] ?? 0
}

function drawSubtitles(context: CanvasRenderingContext2D, width: number) {
  drawTrackBackground(context, 166, 40, width)
  context.fillStyle = colors.text
  context.font = "11px ui-sans-serif, system-ui"
  context.fillText("Subtitles", 12, 181)
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
