export const TARGET_THUMBNAIL_WIDTH = 120

export type LodSelection = {
  intervalSeconds: number
  id: string
  showFrameTicks: boolean
  showEveryFrameImages: boolean
  desiredInterval: number
  thumbnailWidth: number
  label: string
}

export function selectTimelineLod(pixelsPerSecond: number, fps: number): LodSelection {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
  const safePixelsPerSecond = Math.max(0.001, pixelsPerSecond)
  const frameDuration = 1 / safeFps
  const desiredInterval = TARGET_THUMBNAIL_WIDTH / Math.max(1, pixelsPerSecond)
  const intervalSeconds = Math.max(frameDuration, desiredInterval)
  const thumbnailWidth = Math.max(8, intervalSeconds * safePixelsPerSecond)
  const pixelsPerFrame = safePixelsPerSecond / safeFps

  return {
    intervalSeconds,
    id: `lod-${Math.round(intervalSeconds * 1000)}-${Math.round(thumbnailWidth)}`,
    showFrameTicks: pixelsPerFrame >= 8,
    showEveryFrameImages: intervalSeconds === frameDuration,
    desiredInterval,
    thumbnailWidth,
    label: formatPreviewRate(intervalSeconds),
  }
}

export function alignTimeToLod(time: number, intervalSeconds: number) {
  if (intervalSeconds <= 0) return time
  return Math.floor(time / intervalSeconds) * intervalSeconds
}

function formatPreviewRate(intervalSeconds: number) {
  if (intervalSeconds < 1) {
    return `${Math.round(1 / intervalSeconds)} previews/s`
  }

  if (Math.abs(intervalSeconds - 1) < 0.001) {
    return "1 preview/s"
  }

  const rounded = intervalSeconds >= 10 ? Math.round(intervalSeconds) : Math.round(intervalSeconds * 10) / 10
  return `1 preview/${rounded}s`
}
