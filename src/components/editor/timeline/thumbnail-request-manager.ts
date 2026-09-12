import type { MediaService } from "@/services/media-service"
import type { ThumbnailRequest, ThumbnailState } from "@/types/media"
import type { ThumbnailCache } from "./thumbnail-cache"
import { loadBitmapFromUrl } from "./thumbnail-cache"

export type TimelineThumbnailStatus = {
  generation: number
  cacheDir: string | null
  states: Map<string, ThumbnailState>
}

type QueueItem = {
  request: ThumbnailRequest
  priority: number
  key: string
}

export class ThumbnailJobQueue {
  private readonly queued = new Map<string, QueueItem>()
  private readonly running = new Set<string>()
  private readonly service: MediaService
  private readonly cache: ThumbnailCache
  private readonly onUpdate: (status: TimelineThumbnailStatus) => void
  private readonly maxParallel: number
  private activeCount = 0
  private decodeConcurrency = 2
  private disposed = false
  private cancellationEpoch = 0
  private videoId: string | null = null
  private viewport: {start: number; end: number; interval: number} | null = null
  private updateFrame: number | null = null

  setViewport(videoId: string, start: number, end: number, interval: number) {
    if (this.videoId !== videoId) {
      this.cancellationEpoch += 1
      this.cache.clear()
      this.queued.clear()
      this.states.clear()
      this.cacheDir = null
    }
    this.videoId = videoId
    this.viewport = {start, end, interval}
    this.cache.protectVisible(videoId, start, end)
  }

  constructor(
    service: MediaService,
    cache: ThumbnailCache,
    onUpdate: (status: TimelineThumbnailStatus) => void,
    maxParallel = 1,
  ) {
    this.service = service
    this.cache = cache
    this.onUpdate = onUpdate
    this.maxParallel = maxParallel
  }

  generation = 0
  cacheDir: string | null = null
  readonly states = new Map<string, ThumbnailState>()

  setDecodeConcurrency(value: number) {
    this.decodeConcurrency = Math.max(1, Math.min(3, Math.floor(value)))
  }

  request(request: ThumbnailRequest, priority = 0) {
    if (this.disposed) return
    this.videoId ??= request.videoId
    if (this.videoId !== request.videoId || request.generation < this.generation) return
    this.generation = request.generation
    this.removeStaleQueued(request.generation)

    const key = this.makeRequestKey(request)
    if (this.queued.has(key)) return

    this.queued.set(key, { request, priority, key })
    this.setRangeState(request, "queued")
    this.pump()
  }

  cancelQueuedBefore(generation: number, options: { reuseInFlight?: boolean } = {}) {
    this.generation = generation
    if (!options.reuseInFlight) {
      this.cancellationEpoch += 1
    }
    this.removeStaleQueued(generation)
    this.states.clear()
    if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame)
    this.updateFrame = null
    this.onUpdate(this.status())
  }

  dispose() {
    this.disposed = true
    this.generation += 1
    this.queued.clear()
    this.states.clear()
    if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame)
    this.updateFrame = null
  }

  private pump() {
    while (!this.disposed && this.activeCount < this.maxParallel && this.queued.size > 0) {
      const next = [...this.queued.values()].sort((a, b) => b.priority - a.priority)[0]
      this.queued.delete(next.key)
      this.running.add(next.key)
      this.activeCount += 1
      this.setRangeState(next.request, "loading")
      void this.run(next).finally(() => {
        this.activeCount -= 1
        this.running.delete(next.key)
        this.pump()
      })
    }
  }

  private async run(item: QueueItem) {
    const cancellationEpoch = this.cancellationEpoch
    try {
      const times: number[] = []
      for (let time = item.request.startTime; time <= item.request.endTime + .00001; time += item.request.intervalSeconds) times.push(time)
      if (times.every(time => this.cache.getAtTimestamp(item.request.videoId, time))) {
        if (item.request.generation === this.generation) this.setRangeState(item.request, "ready")
        return
      }
      const result = await this.service.generateTimelineThumbnailRange(item.request)
      if (!this.acceptsResult(result.videoId, cancellationEpoch)) {
        return
      }
      this.cacheDir = result.cacheDir
      if (result.generation === this.generation) this.setRangeState(item.request, "missing")

      let nextIndex = 0
      const decodeWorker = async () => {
        while (nextIndex < result.thumbnails.length) {
          const thumbnail = result.thumbnails[nextIndex]
          nextIndex += 1
          if (!this.acceptsResult(result.videoId, cancellationEpoch)) return
          const viewport = this.viewport
          const margin = Math.max(result.intervalSeconds * 2, (viewport?.interval ?? 0) * 2,
            viewport ? (viewport.end - viewport.start) * .75 : 0)
          if (viewport && (thumbnail.time < viewport.start - margin || thumbnail.time > viewport.end + margin)) continue
          const stateKey = this.makeStateKey(
            result.videoId,
            result.intervalSeconds,
            thumbnail.time,
          )
          if (thumbnail.state !== "ready") {
            if (result.generation === this.generation) this.states.set(stateKey, "missing")
            continue
          }

          try {
            const bitmap = await loadBitmapFromUrl(thumbnail.path)
            if (!this.acceptsResult(result.videoId, cancellationEpoch)) {
              bitmap.close()
              return
            }
            this.cache.set(
              result.videoId,
              result.intervalSeconds,
              thumbnail.time,
              bitmap,
              thumbnail.path,
            )
            this.states.set(stateKey, "ready")
            this.notify()
          } catch {
            if (this.acceptsResult(result.videoId, cancellationEpoch) && result.generation === this.generation) this.states.set(stateKey, "missing")
          }
        }
      }
      await Promise.all(
        Array.from({ length: this.decodeConcurrency }, () => decodeWorker()),
      )
    } catch {
      if (this.acceptsResult(item.request.videoId, cancellationEpoch) && item.request.generation === this.generation) this.setRangeState(item.request, "missing")
    } finally {
      if (this.acceptsResult(item.request.videoId, cancellationEpoch)) this.notify()
    }
  }

  private acceptsResult(videoId: string, cancellationEpoch: number) {
    return !this.disposed && videoId === this.videoId && cancellationEpoch === this.cancellationEpoch
  }

  private setRangeState(request: ThumbnailRequest, state: ThumbnailState) {
    for (let time = request.startTime; time <= request.endTime; time += request.intervalSeconds) {
      this.states.set(
        this.makeStateKey(request.videoId, request.intervalSeconds, time),
        state,
      )
    }
    this.notify()
  }

  private notify() {
    if (this.disposed || this.updateFrame !== null) return
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null
      if (!this.disposed) this.onUpdate(this.status())
    })
  }

  private removeStaleQueued(generation: number) {
    for (const [key, item] of this.queued) {
      if (item.request.generation !== generation) this.queued.delete(key)
    }
  }

  private makeRequestKey(request: ThumbnailRequest) {
    return [
      request.videoId,
      Math.round(request.startTime * 1000),
      Math.round(request.endTime * 1000),
      Math.round(request.intervalSeconds * 1000),
      request.thumbnailWidth,
      request.thumbnailHeight,
    ].join(":")
  }

  private makeStateKey(videoId: string, intervalSeconds: number, time: number) {
    return `${videoId}:${Math.round(intervalSeconds * 1000)}:${Math.round(time * 1000)}`
  }

  private status(): TimelineThumbnailStatus {
    while (this.states.size > 2000) {
      const key = this.states.keys().next().value
      if (key == null) break
      this.states.delete(key)
    }
    return {
      generation: this.generation,
      cacheDir: this.cacheDir,
      states: new Map(this.states),
    }
  }
}
