export type CachedThumbnail = {
  time: number
  intervalSeconds: number
  bitmap: ImageBitmap
  sourceUrl: string
  estimatedBytes: number
}

export class ThumbnailCache {
  private readonly items = new Map<string, CachedThumbnail>()
  private maxItems: number
  private maxBytes: number
  private totalBytes = 0

  constructor(maxItems = 250, maxBytes = 128 * 1024 * 1024) {
    this.maxItems = maxItems
    this.maxBytes = maxBytes
  }

  configure(maxItems: number, maxBytes: number) {
    this.maxItems = Math.max(16, Math.floor(maxItems))
    this.maxBytes = Math.max(16 * 1024 * 1024, Math.floor(maxBytes))
    this.evict()
  }

  makeKey(videoId: string, intervalSeconds: number, time: number) {
    return `${videoId}:${Math.round(intervalSeconds * 1000)}:${Math.round(time * 1000)}`
  }

  get(videoId: string, intervalSeconds: number, time: number) {
    const key = this.makeKey(videoId, intervalSeconds, time)
    const item = this.items.get(key)
    if (!item) return null
    this.items.delete(key)
    this.items.set(key, item)
    return item
  }

  getAtTimestamp(videoId: string, time: number) {
    const timestampMs = Math.round(time * 1000)
    let bestKey: string | null = null
    let best: CachedThumbnail | null = null
    for (const [key, item] of this.items) {
      if (!key.startsWith(`${videoId}:`) || Math.round(item.time * 1000) !== timestampMs) continue
      if (!best || item.bitmap.width > best.bitmap.width) {
        bestKey = key
        best = item
      }
    }
    if (bestKey && best) {
      this.items.delete(bestKey)
      this.items.set(bestKey, best)
    }
    return best
  }

  findNearest(
    videoId: string,
    intervalSeconds: number,
    time: number,
    maxDistanceSeconds: number,
  ) {
    let best: CachedThumbnail | null = null
    let bestDistance = maxDistanceSeconds
    for (const [key, item] of this.items) {
      if (!key.startsWith(`${videoId}:`)) continue
      if (Math.round(item.intervalSeconds * 1000) !== Math.round(intervalSeconds * 1000)) continue
      const distance = Math.abs(item.time - time)
      if (distance <= bestDistance) {
        best = item
        bestDistance = distance
      }
    }
    return best
  }

  set(videoId: string, intervalSeconds: number, time: number, bitmap: ImageBitmap, sourceUrl: string) {
    const key = this.makeKey(videoId, intervalSeconds, time)
    const previous = this.items.get(key)
    if (previous) {
      this.totalBytes -= previous.estimatedBytes
      previous.bitmap.close()
    }

    const estimatedBytes = bitmap.width * bitmap.height * 4
    this.items.set(key, { time, intervalSeconds, bitmap, sourceUrl, estimatedBytes })
    this.totalBytes += estimatedBytes
    this.evict()
  }

  clear() {
    for (const item of this.items.values()) item.bitmap.close()
    this.items.clear()
    this.totalBytes = 0
  }

  private evict() {
    while (this.items.size > this.maxItems || this.totalBytes > this.maxBytes) {
      const first = this.items.keys().next().value
      if (!first) return
      const item = this.items.get(first)
      if (item) {
        this.totalBytes -= item.estimatedBytes
        item.bitmap.close()
      }
      this.items.delete(first)
    }
  }
}

export async function loadBitmapFromUrl(url: string): Promise<ImageBitmap> {
  const image = new Image()
  image.decoding = "async"
  image.src = url
  await image.decode()
  return createImageBitmap(image)
}
