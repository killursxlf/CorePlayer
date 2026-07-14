import { alignTimeToLod } from "./lod-selector"
import type { ThumbnailCache } from "./thumbnail-cache"
import type { VisibleRange } from "./visible-range"

type ClientThumbnailRequest = {
  playbackUrl: string
  videoId: string
  range: VisibleRange
  intervalSeconds: number
  thumbnailWidth: number
  thumbnailHeight: number
  duration: number
  cache: ThumbnailCache
  generation: number
  isCurrent: (generation: number) => boolean
  onFrame: () => void
}

function waitForEvent(target: EventTarget, eventName: string) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleEvent)
      target.removeEventListener("error", handleError)
    }
    const handleEvent = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error(`Video ${eventName} failed.`))
    }
    target.addEventListener(eventName, handleEvent, { once: true })
    target.addEventListener("error", handleError, { once: true })
  })
}

async function ensureMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return
  await waitForEvent(video, "loadedmetadata")
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  const target = Math.max(0, time)
  if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return
  }
  video.currentTime = target
  await waitForEvent(video, "seeked")
}

export async function generateClientTimelineThumbnails(request: ClientThumbnailRequest) {
  const video = document.createElement("video")
  video.muted = true
  video.preload = "auto"
  video.src = request.playbackUrl

  await ensureMetadata(video)

  const canvas = document.createElement("canvas")
  canvas.width = request.thumbnailWidth
  canvas.height = request.thumbnailHeight
  const context = canvas.getContext("2d")
  if (!context) return

  const visibleFrameBudget = Math.ceil(
    Math.max(0, request.range.visibleEnd - request.range.visibleStart) / request.intervalSeconds,
  )
  const maxFrames = Math.max(240, visibleFrameBudget + 80)
  let generated = 0

  const generateRange = async (startTime: number, endTime: number) => {
    const start = alignTimeToLod(startTime, request.intervalSeconds)
    for (
      let time = start;
      time < endTime && time < request.duration && generated < maxFrames;
      time += request.intervalSeconds
    ) {
      if (!request.isCurrent(request.generation)) return false

      const roundedTime = Math.round(Math.min(time, request.duration) * 1000) / 1000
      if (request.cache.get(request.videoId, request.intervalSeconds, roundedTime)) continue

      try {
        await seekVideo(video, roundedTime)
        if (!request.isCurrent(request.generation)) return false

        context.fillStyle = "#11131a"
        context.fillRect(0, 0, canvas.width, canvas.height)

        const sourceWidth = video.videoWidth || canvas.width
        const sourceHeight = video.videoHeight || canvas.height
        const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight)
        const drawWidth = sourceWidth * scale
        const drawHeight = sourceHeight * scale
        const drawX = (canvas.width - drawWidth) / 2
        const drawY = (canvas.height - drawHeight) / 2
        context.drawImage(video, drawX, drawY, drawWidth, drawHeight)

        const bitmap = await createImageBitmap(canvas)
        request.cache.set(request.videoId, request.intervalSeconds, roundedTime, bitmap, request.playbackUrl)
        generated += 1
        request.onFrame()
      } catch {
        generated += 1
      }
    }

    return true
  }

  if (!(await generateRange(request.range.visibleStart, request.range.visibleEnd))) return
  if (!(await generateRange(request.range.requestStart, request.range.visibleStart))) return
  await generateRange(request.range.visibleEnd, request.range.requestEnd)
}
