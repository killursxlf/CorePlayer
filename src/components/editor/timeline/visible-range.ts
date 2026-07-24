export type VisibleRange = {
  visibleStart: number
  visibleEnd: number
  requestStart: number
  requestEnd: number
  nearStart: number
  nearEnd: number
  prefetchStart: number
  prefetchEnd: number
  scrollLeft: number
  viewportWidth: number
}

export function calculateVisibleRange(params: {
  scrollLeft: number
  viewportWidth: number
  pixelsPerSecond: number
  duration: number
}): VisibleRange {
  const safePixelsPerSecond = Math.max(0.001, params.pixelsPerSecond)
  const viewportSeconds = params.viewportWidth / safePixelsPerSecond
  const visibleStart = Math.max(0, params.scrollLeft / safePixelsPerSecond)
  const visibleEnd = Math.min(
    params.duration,
    (params.scrollLeft + params.viewportWidth) / safePixelsPerSecond,
  )

  return {
    visibleStart,
    visibleEnd,
    requestStart: Math.max(0, visibleStart - viewportSeconds),
    requestEnd: Math.min(params.duration, visibleEnd + viewportSeconds),
    nearStart: Math.max(0, visibleStart - viewportSeconds * 0.5),
    nearEnd: Math.min(params.duration, visibleEnd + viewportSeconds * 0.5),
    prefetchStart: Math.max(0, visibleStart - viewportSeconds * 1.5),
    prefetchEnd: Math.min(params.duration, visibleEnd + viewportSeconds * 1.5),
    scrollLeft: params.scrollLeft,
    viewportWidth: params.viewportWidth,
  }
}
