import { afterEach, expect, mock, test } from "bun:test"
import { ThumbnailJobQueue } from "../src/components/editor/timeline/thumbnail-request-manager"
import { ThumbnailCache } from "../src/components/editor/timeline/thumbnail-cache"
import type { MediaService } from "../src/services/media-service"
import type { ThumbnailRequest, ThumbnailResult } from "../src/types/media"

const original = {Image: globalThis.Image, createImageBitmap: globalThis.createImageBitmap, requestAnimationFrame: globalThis.requestAnimationFrame}
afterEach(() => Object.assign(globalThis, original))
const request: ThumbnailRequest = {videoId: "video", filePath: "movie.mp4", startTime: 0, endTime: 2, intervalSeconds: 1, thumbnailWidth: 100, thumbnailHeight: 56, generation: 1, priority: "visible"}
const result: ThumbnailResult = {videoId: "video", generation: 1, intervalSeconds: 1, cacheDir: "cache", thumbnails: [{time: 0, path: "", state: "missing"}, {time: 1, path: "frame.jpg", state: "ready"}, {time: 2, path: "frame.jpg", state: "ready"}]}
function setup() {
  globalThis.Image = class { decode() { return Promise.resolve() } } as unknown as typeof Image
  globalThis.requestAnimationFrame = callback => { queueMicrotask(() => callback(0)); return 1 }
  const close = mock(() => {})
  globalThis.createImageBitmap = mock(async () => ({width: 100, height: 56, close}) as ImageBitmap)
  return close
}
test("a missing frame does not stop decoding later ready thumbnails", async () => {
  setup()
  const cache = new ThumbnailCache()
  const service = {generateTimelineThumbnailRange: async () => result} as unknown as MediaService
  let done!: () => void
  const settled = new Promise<void>(resolve => { done = resolve })
  const queue = new ThumbnailJobQueue(service, cache, status => {
    if (status.states.get("video:1000:2000") === "ready") done()
  })
  queue.setDecodeConcurrency(1)
  queue.request(request)
  await settled
  expect(cache.get("video", 1, 1)).not.toBeNull()
  expect(cache.get("video", 1, 2)).not.toBeNull()
  queue.dispose(); cache.clear()
})
test("late decoded bitmaps are released after cancellation", async () => {
  const close = setup()
  let decode!: () => void
  const decoding = new Promise<void>(resolve => { decode = resolve })
  globalThis.createImageBitmap = mock(async () => { await decoding; return {width: 100, height: 56, close} as ImageBitmap })
  const cache = new ThumbnailCache()
  const service = {generateTimelineThumbnailRange: async () => ({...result, thumbnails: [result.thumbnails[1]]})} as unknown as MediaService
  const queue = new ThumbnailJobQueue(service, cache, () => {})
  queue.request(request)
  await new Promise(resolve => setTimeout(resolve, 0))
  queue.cancelQueuedBefore(2)
  decode()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(close).toHaveBeenCalledTimes(1)
  expect(cache.get("video", 1, 1)).toBeNull()
  expect(queue.states.size).toBe(0)
  queue.dispose()
})
