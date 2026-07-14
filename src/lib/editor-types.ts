export type ToolId =
  | "select"
  | "move"
  | "pen"
  | "brush"
  | "arrow"
  | "rectangle"
  | "circle"
  | "blur"
  | "highlight"
  | "text"
  | "crop"
  | "measure"

export type AnnotationType =
  | "arrow"
  | "rectangle"
  | "circle"
  | "text"
  | "blur"
  | "highlight"
  | "pen"
  | "brush"
  | "crop"
  | "measure"

export interface Annotation {
  id: string
  type: AnnotationType
  label: string
  color: string
  opacity: number
  thickness: number
  font: string
  visible: boolean
  startTime: number
  endTime: number
  // normalized position on the preview (0-1)
  x: number
  y: number
  width: number
  height: number
  lineStartX?: number
  lineStartY?: number
  lineEndX?: number
  lineEndY?: number
  pathPoints?: { x: number; y: number }[]
}

export interface VideoInfo {
  filename: string
  duration: number // seconds
  codec: string
  resolution: string
  fps: number
  fpsKnown: boolean
  bitrate: string
  audioStreams: string
  subtitles: string
}

export interface TimelineMarker {
  id: string
  time: number
  label: string
  color: string
}

export interface TimelineClip {
  id: string
  label: string
  startTime: number
  endTime: number
}

export function formatTimecode(seconds: number, fps = 30): string {
  const s = Math.max(0, seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ff = Math.floor((s % 1) * fps)
  const pad = (n: number, l = 2) => String(n).padStart(l, "0")
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(mm)}:${pad(ss)}`
}
