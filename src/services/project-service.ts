import { parseProject } from "@/lib/project-validation"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { Annotation, TimelineClip, TimelineMarker } from "@/lib/editor-types"
import type { ExportSettings } from "@/types/export"

export type ProjectFile = {
  version: 1 | 2
  mediaPath: string
  annotations: Annotation[]
  markers: TimelineMarker[]
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  selectedAnnotationId: string | null
  exportSettings: ExportSettings
  exportScope: "timeline" | "selected" | "all"
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
  return parseProject(contents)
}

export async function writeProject(path: string, project: ProjectFile) {
  await invoke("write_text_file", {
    path,
    contents: `${JSON.stringify(project, null, 2)}\n`,
  })
}
