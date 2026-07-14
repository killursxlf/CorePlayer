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

  request(request: ThumbnailRequest, priority = 0) {
    this.generation = request.generation
    this.removeStaleQueued(request.generation)

    const key = this.makeRequestKey(request)
    if (this.queued.has(key) || this.running.has(key)) return

    this.queued.set(key, { request, priority, key })
    this.setRangeState(request, "queued")
    this.pump()
  }

  cancelQueuedBefore(generation: number) {
    this.generation = generation
    this.removeStaleQueued(generation)
    this.onUpdate(this.status())
  }

  private pump() {
    while (this.activeCount < this.maxParallel && this.queued.size > 0) {
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
    try {
      const result = await this.service.generateTimelineThumbnailRange(item.request)
      this.cacheDir = result.cacheDir

      if (result.generation !== this.generation) {
        return
      }

      await Promise.all(
        result.thumbnails.map(async (thumbnail) => {
          const stateKey = this.makeStateKey(
            result.videoId,
            result.intervalSeconds,
            thumbnail.time,
          )
          const state = thumbnail.state === "error" ? "missing" : thumbnail.state
          this.states.set(stateKey, state)
          if (thumbnail.state !== "ready") return

          try {
            const bitmap = await loadBitmapFromUrl(thumbnail.path)
            this.cache.set(
              result.videoId,
              result.intervalSeconds,
              thumbnail.time,
              bitmap,
              thumbnail.path,
            )
          } catch {
            this.states.set(stateKey, "missing")
          }
        }),
      )
    } catch {
      this.setRangeState(item.request, "missing")
    } finally {
      this.onUpdate(this.status())
    }
  }

  private setRangeState(request: ThumbnailRequest, state: ThumbnailState) {
    for (let time = request.startTime; time <= request.endTime; time += request.intervalSeconds) {
      this.states.set(
        this.makeStateKey(request.videoId, request.intervalSeconds, time),
        state,
      )
    }
    this.onUpdate(this.status())
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
      request.generation,
    ].join(":")
  }

  private makeStateKey(videoId: string, intervalSeconds: number, time: number) {
    return `${videoId}:${Math.round(intervalSeconds * 1000)}:${Math.round(time * 1000)}`
  }

  private status(): TimelineThumbnailStatus {
    return {
      generation: this.generation,
      cacheDir: this.cacheDir,
      states: new Map(this.states),
    }
  }
}
