import type { Annotation, TimelineClip, TimelineMarker } from "./editor-types"

export type TimeRange = [number, number]
export type TimelineContent = { clips: TimelineClip[]; annotations: Annotation[]; markers: TimelineMarker[] }
type Segment = { start: number; end: number; at: number }
const epsilon = 0.000001

export const sourceStart = (clip: TimelineClip) => clip.sourceStart ?? clip.startTime
export const editDuration = (clips: TimelineClip[]) => Math.max(0, ...clips.map(clip => clip.endTime))
export const clipAt = (clips: TimelineClip[], time: number) => clips.find(clip => time >= clip.startTime && time < clip.endTime)
export const sourceTime = (clip: TimelineClip, time: number) => sourceStart(clip) + time - clip.startTime
export const editTime = (clip: TimelineClip, time: number) => clip.startTime + time - sourceStart(clip)

export function snapToEdges(time: number, edges: number[], pixelsPerSecond: number, enabled: boolean, bounds: TimeRange): { time: number; edge: number | null } {
  const raw = Math.max(bounds[0], Math.min(bounds[1], time))
  let edge: number | null = null
  let distance = 10 / pixelsPerSecond
  if (enabled) for (const point of edges) {
    if (point < bounds[0] || point > bounds[1]) continue
    const delta = Math.abs(raw - point)
    if (delta < distance) { distance = delta; edge = point }
  }
  return { time: edge ?? raw, edge }
}

export function timelineGaps(clips: TimelineClip[], duration = editDuration(clips)): TimeRange[] {
  let cursor = 0
  const gaps: TimeRange[] = []
  for (const clip of [...clips].sort((a, b) => a.startTime - b.startTime)) {
    if (clip.startTime > cursor + epsilon) gaps.push([cursor, clip.startTime])
    cursor = Math.max(cursor, clip.endTime)
  }
  if (cursor < duration - epsilon) gaps.push([cursor, duration])
  return gaps
}

export function splitClip(clips: TimelineClip[], time: number, minimum: number): TimelineClip[] {
  const clip = clipAt(clips, time)
  if (!clip || time - clip.startTime < minimum || clip.endTime - time < minimum) return clips
  return clips.flatMap(item => item.id !== clip.id ? [item] : [
    { ...item, sourceStart: sourceStart(item), endTime: time },
    { ...item, id: crypto.randomUUID(), sourceStart: sourceTime(item, time), startTime: time },
  ])
}

function mergedRanges(ranges: TimeRange[], duration: number) {
  const result: TimeRange[] = []
  for (const [a, b] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(0, a), end = Math.min(duration, b)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + epsilon) continue
    const previous = result.at(-1)
    if (previous && start <= previous[1] + epsilon) previous[1] = Math.max(previous[1], end)
    else result.push([start, end])
  }
  return result
}

function remap(content: TimelineContent, segments: Segment[]): TimelineContent {
  const used = new Set<string>()
  function remapItems<T extends TimelineClip | Annotation>(items: T[], media: boolean): T[] {
    return segments.flatMap(segment => items.flatMap(item => {
      const start = Math.max(item.startTime, segment.start), end = Math.min(item.endTime, segment.end)
      if (end <= start + epsilon) return []
      const id = used.has(item.id) ? crypto.randomUUID() : item.id
      used.add(id)
      return [{ ...item, id, startTime: segment.at + start - segment.start, endTime: segment.at + end - segment.start,
        ...(media ? { sourceStart: sourceStart(item) + start - item.startTime } : {}) }]
    })).sort((a, b) => a.startTime - b.startTime)
  }
  return {
    clips: remapItems(content.clips, true),
    annotations: remapItems(content.annotations, false),
    markers: content.markers.flatMap(marker => {
      const segment = segments.find(s => marker.time >= s.start && marker.time < s.end)
      return segment ? [{ ...marker, time: segment.at + marker.time - segment.start }] : []
    }),
  }
}

export function deleteRanges(content: TimelineContent, ranges: TimeRange[], ripple: boolean): TimelineContent {
  const duration = editDuration(content.clips)
  const cuts = mergedRanges(ranges, duration)
  if (!cuts.length) return content
  const segments: Segment[] = []
  let cursor = 0, removed = 0
  for (const [start, end] of cuts) {
    if (start > cursor) segments.push({ start: cursor, end: start, at: cursor - (ripple ? removed : 0) })
    removed += end - start
    cursor = end
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, at: cursor - (ripple ? removed : 0) })
  return remap(content, segments)
}

/** Insert the selected footage at the drop point, keeping source frames and attached effects. */
export function moveClips(content: TimelineContent, ids: string[], target: number): TimelineContent {
  return moveRanges(content, content.clips.filter(c => ids.includes(c.id)).map(c => [c.startTime, c.endTime]), target)
}

export function moveRanges(content: TimelineContent, ranges: TimeRange[], target: number): TimelineContent {
  const duration = editDuration(content.clips)
  const moving = mergedRanges(ranges, duration)
  if (!moving.length || !Number.isFinite(target)) return content
  target = Math.max(0, Math.min(duration, target))
  if (moving.length === 1 && target >= moving[0][0] && target <= moving[0][1]) return content
  const removedBefore = moving.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(target, end) - start), 0)
  const insertAt = target - removedBefore
  const remaining: Segment[] = []
  let cursor = 0, at = 0
  for (const [start, end] of [...moving, [duration, duration] as TimeRange]) {
    if (start > cursor) { remaining.push({ start: cursor, end: start, at }); at += start - cursor }
    cursor = end
  }
  const before: Segment[] = [], after: Segment[] = []
  for (const segment of remaining) {
    const split = Math.max(segment.start, Math.min(segment.end, segment.start + insertAt - segment.at))
    if (split > segment.start) before.push({ ...segment, end: split })
    if (split < segment.end) after.push({ start: split, end: segment.end, at: 0 })
  }
  const ordered = [...before, ...moving.map(([start, end]) => ({ start, end, at: 0 })), ...after]
  at = 0
  for (const segment of ordered) { segment.at = at; at += segment.end - segment.start }
  return remap(content, ordered)
}

export function trimClip(clips: TimelineClip[], id: string, range: TimeRange, sourceDuration: number, minimum: number): TimelineClip[] {
  const clip = clips.find(c => c.id === id)
  if (!clip || !range.every(Number.isFinite)) return clips
  const previous = Math.max(0, ...clips.filter(c => c.endTime <= clip.startTime && c.id !== id).map(c => c.endTime))
  const next = Math.min(Infinity, ...clips.filter(c => c.startTime >= clip.endTime && c.id !== id).map(c => c.startTime))
  const earliest = Math.max(previous, clip.startTime - sourceStart(clip))
  const latest = Math.min(next, clip.startTime + sourceDuration - sourceStart(clip))
  const start = Math.max(earliest, Math.min(range[0], clip.endTime - minimum))
  const end = Math.max(start + minimum, Math.min(range[1], latest))
  if (Math.abs(start - clip.startTime) < epsilon && Math.abs(end - clip.endTime) < epsilon) return clips
  return clips.map(c => c.id !== id ? c : { ...c, startTime: start, endTime: end, sourceStart: sourceTime(c, start) })
}

export function visibleSourceRanges(clips: TimelineClip[], start: number, end: number): TimeRange[] {
  return clips.flatMap(clip => {
    const a = Math.max(start, clip.startTime), b = Math.min(end, clip.endTime)
    return b > a ? [[sourceTime(clip, a), sourceTime(clip, b)] as TimeRange] : []
  })
}
