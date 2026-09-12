import type { ProjectFile } from "@/services/project-service"
import { compatibleExportSettings, DEFAULT_EXPORT_SETTINGS } from "./export-settings"

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid Lumen project: check clip times, annotations and export settings.")
}
function record(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value))
}
function number(value: unknown, min: number, max = Number.MAX_VALUE): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
}
function text(value: unknown): value is string { return typeof value === "string" }
function items(value: unknown) { check(Array.isArray(value)); return value as unknown[] }
function identified(value: unknown) {
  record(value)
  check(text(value.id) && value.id.length > 0 && text(value.label))
  return value
}
function unique(values: unknown[]) {
  const ids = values.map(value => identified(value).id)
  check(new Set(ids).size === ids.length)
}
function range(value: Record<string, unknown>) {
  check(number(value.startTime, 0) && number(value.endTime, 0) && value.endTime > value.startTime)
}

export function parseProject(contents: string): ProjectFile {
  const value: unknown = JSON.parse(contents)
  record(value)
  check((value.version === 1 || value.version === 2) && text(value.mediaPath) && value.mediaPath.trim().length > 0)
  const clips = items(value.clips ?? [])
  const annotations = items(value.annotations ?? [])
  const markers = items(value.markers ?? [])
  for (const list of [clips, annotations, markers]) unique(list)
  for (const clip of clips) {
    const item = identified(clip)
    range(item)
    check(item.sourceStart === undefined || number(item.sourceStart, 0))
  }
  const sortedClips = [...clips as ProjectFile["clips"]].sort((a, b) => a.startTime - b.startTime)
  if (value.version === 2) check(sortedClips.every((clip, index) => index === 0 || clip.startTime >= sortedClips[index - 1].endTime - 0.000001))
  let cursor = 0
  const restoredClips = sortedClips.map(clip => {
    const startTime = Math.max(cursor, clip.startTime)
    cursor = startTime + clip.endTime - clip.startTime
    return { ...clip, sourceStart: clip.sourceStart ?? clip.startTime, startTime, endTime: cursor }
  })
  for (const marker of markers) {
    const m = identified(marker)
    check(number(m.time, 0) && text(m.color) && /^#[\da-f]{6}$/i.test(m.color))
  }
  for (const annotation of annotations) {
    const a = identified(annotation)
    range(a)
    check(["arrow", "rectangle", "circle", "text", "blur", "highlight", "pen", "brush", "crop", "measure"].includes(String(a.type)))
    check(text(a.color) && /^#[\da-f]{6}$/i.test(a.color) && text(a.font) && typeof a.visible === "boolean")
    check(number(a.opacity, 0, 100) && number(a.thickness, 1, 80))
    check(number(a.x, 0, 1) && number(a.y, 0, 1) && number(a.width, 0.001, 1) && number(a.height, 0.001, 1))
    check(a.x + a.width <= 1.001 && a.y + a.height <= 1.001)
    for (const key of ["lineStartX", "lineStartY", "lineEndX", "lineEndY"]) check(a[key] === undefined || number(a[key], 0, 1))
    if (a.pathPoints !== undefined) for (const point of items(a.pathPoints)) {
      record(point); check(number(point.x, 0, 1) && number(point.y, 0, 1))
    }
  }
  const settings = { ...DEFAULT_EXPORT_SETTINGS }
  if (value.exportSettings != null) {
    record(value.exportSettings)
    Object.assign(settings, value.exportSettings)
  }
  check(["mp4", "mov", "mkv", "webm"].includes(settings.format))
  check(["encode", "stream-copy"].includes(settings.mode))
  check(["copy", "h264", "h265", "av1", "vp9"].includes(settings.videoCodec))
  check(["copy", "aac", "opus", "mp3"].includes(settings.audioCodec))
  check(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].includes(settings.preset))
  for (const key of ["width", "height"] as const) check(settings[key] === null || (number(settings[key], 2, 16384) && settings[key]! % 2 === 0))
  for (const key of ["videoBitrateKbps", "audioBitrateKbps"] as const) check(settings[key] === null || (number(settings[key], 1, 1_000_000) && Number.isInteger(settings[key])))
  check(settings.fps === null || number(settings.fps, 0.001, 240))
  check(settings.crf === null || (number(settings.crf, 0, 63) && Number.isInteger(settings.crf)))
  const volume = value.volume ?? 1
  const playbackRate = value.playbackRate ?? 1
  check(number(volume, 0, 1) && number(playbackRate, 0.25, 4))
  const selectedClipIds = items(value.selectedClipIds ?? [])
  check(selectedClipIds.every(text))
  for (const key of ["selectedClipId", "selectedAnnotationId"]) check(value[key] == null || text(value[key]))
  return {
    version: 2, mediaPath: value.mediaPath,
    clips: restoredClips, annotations: annotations as ProjectFile["annotations"], markers: markers as ProjectFile["markers"],
    selectedClipId: value.selectedClipId as string | null ?? null,
    selectedClipIds: selectedClipIds as string[],
    selectedAnnotationId: value.selectedAnnotationId as string | null ?? null,
    exportSettings: compatibleExportSettings(settings), exportScope: value.exportScope === "timeline" ? "timeline" : value.exportScope === "all" ? "all" : "selected",
    volume, playbackRate,
  }
}
