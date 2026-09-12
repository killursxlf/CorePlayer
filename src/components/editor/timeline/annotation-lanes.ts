import type { Annotation } from "@/lib/editor-types"
import { RULER_HEIGHT, VIDEO_ROW_HEIGHT } from "./timeline-layout"

export const ANNOTATION_TRACK_TOP = RULER_HEIGHT + VIDEO_ROW_HEIGHT + 4
export const ANNOTATION_TRACK_HEIGHT = 40
export const ANNOTATION_LANE_COUNT = 3
export const ANNOTATION_LANE_HEIGHT = 10
export const ANNOTATION_LANE_GAP = 2

export function annotationLaneTop(lane: number) {
  return ANNOTATION_TRACK_TOP + 5 + lane * (ANNOTATION_LANE_HEIGHT + ANNOTATION_LANE_GAP)
}

export function assignAnnotationLanes(annotations: Annotation[]) {
  const lanes = new Map<string, number>()
  const laneEnds = Array.from({ length: ANNOTATION_LANE_COUNT }, () => -Infinity)
  const sorted = [...annotations].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)

  for (const annotation of sorted) {
    const freeLane = laneEnds.findIndex((end) => end <= annotation.startTime)
    const lane =
      freeLane >= 0
        ? freeLane
        : laneEnds.reduce((best, end, index) => (end < laneEnds[best] ? index : best), 0)
    lanes.set(annotation.id, lane)
    laneEnds[lane] = annotation.endTime
  }

  return lanes
}
