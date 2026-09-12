import { beforeEach, expect, mock, test } from "bun:test"
import type { ExportProgressEvent } from "../src/types/export"
import { DEFAULT_EXPORT_SETTINGS } from "../src/lib/export-settings"

let selected: string | null = null
let invokeImpl: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async () => null
let progress: ((event: {payload: ExportProgressEvent}) => void) | undefined
const stop = mock(() => {})
const invoke = mock((command: string, args?: Record<string, unknown>) => invokeImpl(command, args))
mock.module("@tauri-apps/api/core", () => ({invoke, convertFileSrc: (path: string) => path}))
mock.module("@tauri-apps/plugin-dialog", () => ({open: async () => selected, save: async () => selected}))
mock.module("@tauri-apps/api/event", () => ({listen: async (_name: string, handler: typeof progress) => { progress = handler; return stop }}))
const { tauriMediaService } = await import("../src/services/tauri-media-service")
beforeEach(() => { selected = null; progress = undefined; invoke.mockClear(); stop.mockClear() })

test("cancelling the open dialog does not touch the current registration", async () => {
  expect(await tauriMediaService.openMedia()).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})
test("invalid input is rejected before registering a playback URL", async () => {
  selected = "broken.mp4"
  invokeImpl = async command => { if (command === "probe_media") throw new Error("Invalid media"); throw new Error("Unexpected registration") }
  await expect(tauriMediaService.openMedia()).rejects.toThrow("Invalid media")
  expect(invoke.mock.calls.map(call => call[0])).toEqual(["probe_media"])
})
test("successful open probes before registering playback", async () => {
  selected = "good.mp4"
  invokeImpl = async command => command === "probe_media" ? {duration: 10} : {streamUrl: "http://127.0.0.1:9000/media"}
  expect(await tauriMediaService.openMedia()).toMatchObject({originalPath: "good.mp4", probe: {duration: 10}})
  expect(invoke.mock.calls.map(call => call[0])).toEqual(["probe_media", "register_playback_media"])
})
test("export filters other operations and retains completion before the IPC reply", async () => {
  const received: ExportProgressEvent[] = []
  invokeImpl = async (_command, args) => {
    const request = args?.request as {operationId: string; outputPath: string}
    progress?.({payload: {operationId: "other", progress: 0, status: "failed"}})
    progress?.({payload: {operationId: request.operationId, progress: 1, status: "completed"}})
    return {operationId: request.operationId, outputPath: request.outputPath}
  }
  const started = await tauriMediaService.exportTrim({inputPath: "good.mp4", outputPath: "export.mp4", clips: [{id: "clip", label: "Clip", startTime: 0, endTime: 1}], settings: DEFAULT_EXPORT_SETTINGS}, event => received.push(event))
  expect(received).toEqual([{operationId: started.operationId, progress: 1, status: "completed"}])
  expect(stop).toHaveBeenCalledTimes(1)
})
test("a rejected export releases its event listener", async () => {
  invokeImpl = async () => { throw new Error("Cannot export") }
  await expect(tauriMediaService.exportTrim({inputPath: "good.mp4", outputPath: "export.mp4", clips: [], settings: DEFAULT_EXPORT_SETTINGS}, () => {})).rejects.toThrow("Cannot export")
  expect(stop).toHaveBeenCalledTimes(1)
})
