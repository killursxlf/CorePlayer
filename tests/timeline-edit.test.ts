import { expect, test } from "bun:test"
import { deleteRanges, moveClips, moveRanges, sourceStart, sourceTime, editTime, splitClip, snapToEdges, timelineGaps, trimClip, visibleSourceRanges, type TimelineContent } from "../src/lib/timeline-edit"
import { parseProject } from "../src/lib/project-validation"

const content: TimelineContent = {
  clips: [0, 10, 20].map((startTime, index) => ({ id: String(index), label: String(index), startTime, endTime: startTime + 10 })),
  annotations: [{ id: "note", label: "note", startTime: 7, endTime: 17, type: "text", color: "#ffffff", opacity: 100, thickness: 2, font: "Arial", visible: true, x: 0, y: 0, width: 0.2, height: 0.2 }],
  markers: [{ id: "cut", label: "cut", time: 10, color: "#ffffff" }, { id: "keep", label: "keep", time: 22, color: "#ffffff" }],
}
const frames = (value: TimelineContent) => value.clips.map(c => [c.startTime, c.endTime, sourceStart(c)])

test("range deletion splits footage and ripples clips, effects and markers together", () => {
  const next = deleteRanges(content, [[5, 15]], true)
  expect(frames(next)).toEqual([[0, 5, 0], [5, 10, 15], [10, 20, 20]])
  expect(next.annotations.map(a => [a.startTime, a.endTime])).toEqual([[5, 7]])
  expect(next.markers.map(m => [m.id, m.time])).toEqual([["keep", 12]])
  expect(frames(content)).toEqual([[0, 10, 0], [10, 20, 10], [20, 30, 20]])
})

test("empty gaps can be selected and removed, and deleting the last clip stays empty", () => {
  const withGap = deleteRanges(content, [[10, 20]], false)
  expect(timelineGaps(withGap.clips)).toEqual([[10, 20]])
  expect(frames(deleteRanges(withGap, [[10, 20]], true))).toEqual([[0, 10, 0], [10, 20, 20]])
  expect(deleteRanges(content, [[0, 30]], true).clips).toEqual([])
  expect(parseProject(JSON.stringify({ version: 2, mediaPath: "source.mp4", clips: [] })).clips).toEqual([])
})

test("moving one or several clips changes their order without changing their footage", () => {
  const moved = moveClips(content, ["2"], 0)
  expect(frames(moved)).toEqual([[0, 10, 20], [10, 20, 0], [20, 30, 10]])
  expect(moved.markers.find(m => m.id === "keep")?.time).toBe(2)
  expect(frames(moveClips(content, ["0", "2"], 30))).toEqual([[0, 10, 10], [10, 20, 0], [20, 30, 20]])
  const inserted = moveClips(content, ["2"], 5)
  expect(frames(inserted)).toEqual([[0, 5, 0], [5, 15, 20], [15, 20, 5], [20, 30, 10]])
  expect(new Set(inserted.clips.map(c => c.id)).size).toBe(inserted.clips.length)
  expect(frames(moveRanges(content, [[5, 15]], 0))).toEqual([[0, 5, 5], [5, 10, 10], [10, 15, 0], [15, 20, 15], [20, 30, 20]])
  expect(moveRanges(content, [[5, 15]], 10)).toBe(content)
})

test("split, trim, thumbnail and playhead mapping use source positions after a move", () => {
  const moved = moveClips(content, ["2"], 0)
  const split = splitClip(moved.clips, 4, 1 / 30)
  expect(split.slice(0, 2).map(c => [c.startTime, c.endTime, sourceStart(c)])).toEqual([[0, 4, 20], [4, 10, 24]])
  const trimmed = trimClip(moved.clips, "2", [2, 8], 30, 1 / 30)
  expect(sourceTime(trimmed[0], 3)).toBe(23)
  expect(editTime(trimmed[0], 23)).toBe(3)
  expect(visibleSourceRanges(trimmed, 0, 12)).toEqual([[22, 28], [0, 2]])
  expect(trimClip(trimmed, "2", [0, 999], 30, 1 / 30)[0].endTime).toBe(10)
})

test("magnet has a constant pixel radius and can be disabled", () => {
  expect(snapToEdges(9.6, [10], 10, true, [0, 30]).time).toBe(10)
  expect(snapToEdges(9.6, [10], 100, true, [0, 30]).edge).toBeNull()
  expect(snapToEdges(9.96, [10], 100, true, [0, 30]).time).toBe(10)
  expect(snapToEdges(9.96, [10], 100, false, [0, 30]).time).toBe(9.96)
})

test("saved edits retain source positions and reject invalid or overlapping ranges", () => {
  const clips = moveClips(content, ["2"], 0).clips
  const loaded = parseProject(JSON.stringify({ version: 2, mediaPath: "source.mp4", clips }))
  expect(loaded.clips).toEqual(clips)
  for (const invalid of [{ ...clips[0], sourceStart: -1 }, { ...clips[0], sourceStart: "oops" }]) {
    expect(() => parseProject(JSON.stringify({ version: 2, mediaPath: "source.mp4", clips: [invalid] }))).toThrow()
  }
  expect(() => parseProject(JSON.stringify({ version: 2, mediaPath: "source.mp4", clips: [clips[0], { ...clips[1], startTime: 5 }] }))).toThrow()
})
