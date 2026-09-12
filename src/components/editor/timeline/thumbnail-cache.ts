export type CachedThumbnail = {
  videoId: string
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
  private visible: {videoId: string; start: number; end: number} | null = null

  protectVisible(videoId: string, start: number, end: number) {
    this.visible = {videoId, start, end}
  }

  constructor(maxItems = 250, maxBytes = 128 * 1024 * 1024) {
    this.maxItems = maxItems
    this.maxBytes = maxBytes
  }

  configure(maxItems: number, maxBytes: number) {
    this.maxItems = Math.max(16, Math.floor(maxItems))
    this.maxBytes = Math.max(16 * 1024 * 1024, Math.floor(maxBytes))
    this.evict()
  }

  makeKey(videoId: string, _intervalSeconds: number, time: number) {
    return `${videoId}:${Math.round(time * 1000)}`
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
    return this.get(videoId, 0, time)
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
      const distance = Math.abs(item.time - time)
      const coverage = Math.max(maxDistanceSeconds, item.intervalSeconds / 2, intervalSeconds / 2)
      if (distance <= coverage && (!best || distance < bestDistance)) {
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
      if (previous.bitmap.width >= bitmap.width) {
        bitmap.close()
        return
      }
      this.totalBytes -= previous.estimatedBytes
      previous.bitmap.close()
    }

    const estimatedBytes = bitmap.width * bitmap.height * 4
    this.items.set(key, { videoId, time, intervalSeconds, bitmap, sourceUrl, estimatedBytes })
    this.totalBytes += estimatedBytes
    this.evict()
  }

  clear() {
    for (const item of this.items.values()) item.bitmap.close()
    this.items.clear()
    this.totalBytes = 0
    this.visible = null
  }

  private evict() {
    while (this.items.size > this.maxItems || this.totalBytes > this.maxBytes) {
      const visible = this.visible
      const first = (visible ? [...this.items.entries()].find(([, item]) => item.videoId !== visible.videoId
        || item.time + item.intervalSeconds < visible.start || item.time - item.intervalSeconds > visible.end)?.[0] : null)
        ?? this.items.keys().next().value
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
