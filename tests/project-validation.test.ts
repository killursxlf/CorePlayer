import { expect, test } from "bun:test"
import { parseProject } from "../src/lib/project-validation"
import { compatibleExportSettings, DEFAULT_EXPORT_SETTINGS } from "../src/lib/export-settings"
import { isValidTrimRange, parseTimecode } from "../src/utils/time"

const project = { version: 1, mediaPath: "movie.mp4", clips: [{id: "clip", label: "Clip", startTime: 0, endTime: 10}] }
test("old minimal projects receive complete export defaults", () => {
  const parsed = parseProject(JSON.stringify(project))
  expect(parsed.exportSettings).toEqual(DEFAULT_EXPORT_SETTINGS)
  expect(parsed.volume).toBe(1)
})
test.each([null, [], { ...project, mediaPath: 1 }, { ...project, clips: [null] },
  { ...project, clips: [{ ...project.clips[0], endTime: -1 }] },
  { ...project, clips: [project.clips[0], project.clips[0]] },
  { ...project, annotations: [{ id: "a", label: "invalid" }] },
  { ...project, volume: 10 }, { ...project, playbackRate: 0 },
  { ...project, exportSettings: { width: 321 } },
].map(value => [value]))("rejects malformed projects before replacing current media: %j", value => {
  expect(() => parseProject(JSON.stringify(value))).toThrow()
})
test("WebM selects compatible encoders and disables stream copy", () => {
  expect(compatibleExportSettings({...DEFAULT_EXPORT_SETTINGS, format: "webm", mode: "stream-copy"})).toMatchObject({mode: "encode", videoCodec: "vp9", audioCodec: "opus"})
})
test("time input rejects invalid fields and nonfinite ranges", () => {
  expect(parseTimecode("01:02:03:15", 30)).toBe(3723.5)
  for (const value of ["00:60:00:00", "00:00:60:00", "00:00:00:30", "-1:00:00:00", "00:00", "0:0:0:0"]) expect(parseTimecode(value, 30)).toBeNull()
  expect(isValidTrimRange(0, Infinity)).toBe(false)
  expect(isValidTrimRange(NaN, 1)).toBe(false)
})
