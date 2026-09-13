import type { Annotation } from "@/lib/editor-types"
import { RULER_HEIGHT, VIDEO_ROW_HEIGHT, ANNOTATION_ROW_HEIGHT } from "./timeline-layout"

export const ANNOTATION_TRACK_TOP = RULER_HEIGHT + VIDEO_ROW_HEIGHT + 4
export const ANNOTATION_TRACK_HEIGHT = ANNOTATION_ROW_HEIGHT - 8
export const ANNOTATION_LANE_HEIGHT = 28
export const ANNOTATION_LANE_GAP = 4

export function annotationLaneTop(lane: number) {
  return lane * (ANNOTATION_LANE_HEIGHT + ANNOTATION_LANE_GAP)
}

export function assignAnnotationLanes(annotations: Annotation[], pixelsPerSecond = 100) {
  const lanes = new Map<string, number>()
  const laneEnds: number[] = []
  const sorted = [...annotations].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)

  for (const annotation of sorted) {
    const freeLane = laneEnds.findIndex((end) => end <= annotation.startTime)
    // ponytail: linear lane search suffices for thousands of objects; use a heap if profiling warrants it.
    const lane = freeLane >= 0 ? freeLane : laneEnds.length
    lanes.set(annotation.id, lane)
    laneEnds[lane] = Math.max(annotation.endTime, annotation.startTime + 28 / pixelsPerSecond) + 4 / pixelsPerSecond
  }

  return lanes
}
