import { expect, test } from "bun:test"
import { PreviewSeekQueue } from "../src/lib/preview-seek-queue"

test("a slow decoder receives the newest drag position after its current seek", () => {
  const queue = new PreviewSeekQueue()
  const seeks: number[] = []
  const apply = (time: number) => { seeks.push(time) }
  queue.request(1, false, apply)
  for (let time = 2; time < 100; time++) queue.request(time, true, apply)
  expect(seeks).toEqual([1])
  queue.flush(apply)
  expect(seeks).toEqual([1, 99])
  queue.flush(apply)
  expect(seeks).toEqual([1, 99])
})

test("release or source replacement discards obsolete preview positions", () => {
  const queue = new PreviewSeekQueue()
  queue.request(90, true, () => { throw Error("decoder is busy") })
  queue.clear()
  queue.flush(() => { throw Error("stale seek after a precise release") })
})
