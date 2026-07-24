import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { Annotation, TimelineClip, TimelineMarker } from "@/lib/editor-types"
import type { ExportSettings } from "@/types/export"

export type ProjectFile = {
  version: 1
  mediaPath: string
  annotations: Annotation[]
  markers: TimelineMarker[]
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  selectedAnnotationId: string | null
  exportSettings: ExportSettings
  exportScope: "selected" | "all"
  volume: number
  playbackRate: number
}

const projectFilters = [{ name: "Lumen Project", extensions: ["json"] }]

export async function chooseProjectToOpen() {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open Project",
    filters: projectFilters,
  })

  return typeof selected === "string" ? selected : null
}

export async function chooseProjectToSave(defaultPath = "project.lumen.json") {
  const selected = await save({
    title: "Save Project",
    defaultPath,
    filters: projectFilters,
  })

  return typeof selected === "string" ? selected : null
}

export async function readProject(path: string): Promise<ProjectFile> {
  const contents = await invoke<string>("read_text_file", { path })
  const parsed = JSON.parse(contents) as Partial<ProjectFile>

  if (parsed.version !== 1 || !parsed.mediaPath) {
    throw new Error("Unsupported or invalid Lumen project file.")
  }

  return {
    version: 1,
    mediaPath: parsed.mediaPath,
    annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
    markers: Array.isArray(parsed.markers) ? parsed.markers : [],
    clips: Array.isArray(parsed.clips) ? parsed.clips : [],
    selectedClipId: parsed.selectedClipId ?? null,
    selectedClipIds: Array.isArray(parsed.selectedClipIds) ? parsed.selectedClipIds : [],
    selectedAnnotationId: parsed.selectedAnnotationId ?? null,
    exportSettings: parsed.exportSettings as ExportSettings,
    exportScope: parsed.exportScope === "all" ? "all" : "selected",
    volume: typeof parsed.volume === "number" ? parsed.volume : 1,
    playbackRate: typeof parsed.playbackRate === "number" ? parsed.playbackRate : 1,
  }
}

export async function writeProject(path: string, project: ProjectFile) {
  await invoke("write_text_file", {
    path,
    contents: `${JSON.stringify(project, null, 2)}\n`,
  })
}
