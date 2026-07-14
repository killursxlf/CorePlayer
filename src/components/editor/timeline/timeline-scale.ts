export const MIN_PIXELS_PER_SECOND = 0.02
export const MAX_PIXELS_PER_SECOND = 240

export type TimelineScale = {
  pixelsPerSecond: number
  fps: number
  frameDuration: number
  pixelsPerFrame: number
  timeToX: (timeSeconds: number) => number
  xToTime: (x: number) => number
  snapTime: (timeSeconds: number, force?: boolean) => number
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function createTimelineScale(pixelsPerSecond: number, fps: number): TimelineScale {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
  const safePixelsPerSecond = clamp(pixelsPerSecond, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND)
  const frameDuration = 1 / safeFps
  const pixelsPerFrame = safePixelsPerSecond / safeFps

  return {
    pixelsPerSecond: safePixelsPerSecond,
    fps: safeFps,
    frameDuration,
    pixelsPerFrame,
    timeToX: (timeSeconds) => timeSeconds * safePixelsPerSecond,
    xToTime: (x) => x / safePixelsPerSecond,
    snapTime: (timeSeconds, force = false) => {
      if (!force && pixelsPerFrame < 20) return timeSeconds
      return Math.max(0, Math.round(timeSeconds / frameDuration) * frameDuration)
    },
  }
}

export function zoomAroundCursor(params: {
  currentPixelsPerSecond: number
  deltaY: number
  cursorX: number
  scrollLeft: number
}) {
  const zoomFactor = params.deltaY < 0 ? 1.15 : 1 / 1.15
  const nextPixelsPerSecond = clamp(
    params.currentPixelsPerSecond * zoomFactor,
    MIN_PIXELS_PER_SECOND,
    MAX_PIXELS_PER_SECOND,
  )
  const timeAtCursor = (params.scrollLeft + params.cursorX) / params.currentPixelsPerSecond
  return {
    pixelsPerSecond: nextPixelsPerSecond,
    scrollLeft: Math.max(0, timeAtCursor * nextPixelsPerSecond - params.cursorX),
  }
}
