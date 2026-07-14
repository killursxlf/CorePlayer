export type CachedThumbnail = {
  time: number
  intervalSeconds: number
  bitmap: ImageBitmap
  sourceUrl: string
}

export class ThumbnailCache {
  private readonly items = new Map<string, CachedThumbnail>()
  private readonly maxItems: number

  constructor(maxItems = 350) {
    this.maxItems = maxItems
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

  findNearest(videoId: string, time: number, maxDistanceSeconds: number) {
    let best: CachedThumbnail | null = null
    let bestDistance = maxDistanceSeconds
    for (const [key, item] of this.items) {
      if (!key.startsWith(`${videoId}:`)) continue
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
    if (previous) previous.bitmap.close()

    this.items.set(key, { time, intervalSeconds, bitmap, sourceUrl })
    this.evict()
  }

  clear() {
    for (const item of this.items.values()) item.bitmap.close()
    this.items.clear()
  }

  private evict() {
    while (this.items.size > this.maxItems) {
      const first = this.items.keys().next().value
      if (!first) return
      const item = this.items.get(first)
      item?.bitmap.close()
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
