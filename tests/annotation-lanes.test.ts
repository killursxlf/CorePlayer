import { test, expect } from "bun:test"
import { assignAnnotationLanes } from "../src/components/editor/timeline/annotation-lanes"
import type { Annotation } from "../src/lib/editor-types"

test("overlapping drawings remain individually selectable, including short bars at low zoom", () => {
  const drawing = { type: "pen", label: "Stroke", color: "#3b82f6", visible: true, opacity: 100,
    thickness: 2, font: "Inter", x: 0, y: 0, width: 0.5, height: 0.5 } as const
  const annotations: Annotation[] = Array.from({ length: 1000 }, (_, i) => ({ ...drawing, id: String(i), startTime: 0, endTime: 5 }))
  expect(new Set(assignAnnotationLanes(annotations).values()).size).toBe(1000)
  const short = [0, 0.1, 4].map((startTime, i) => ({ ...drawing, id: String(i), startTime, endTime: startTime + 0.01 }))
  const lanes = assignAnnotationLanes(short, 10)
  expect(lanes.get("0")).not.toBe(lanes.get("1"))
  expect(lanes.get("0")).toBe(lanes.get("2"))
  expect(assignAnnotationLanes([]).size).toBe(0)
})
