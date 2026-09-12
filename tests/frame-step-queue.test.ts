import { expect, test } from "bun:test"
import { FrameStepQueue } from "../src/lib/frame-step-queue"
import type { FrameStep } from "../src/types/media"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const step = (time: number): FrameStep => ({ time, seekTime: time + .001, atBoundary: false })
test("rapid mixed steps preserve click order and use the requested cursor", async () => {
  const times = [0,.04,.12,.14,.3]
  const published: number[] = []
  const queue = new FrameStepQueue({
    currentTime: () => 0,
    read: async (time, direction) => { await tick(); return step(times[Math.max(0, Math.min(times.length - 1, times.indexOf(time) + direction))]) },
    publish: frame => published.push(frame.time), cancelRead: async () => {}, busy: () => {}, error: error => { throw error },
  })
  for (const direction of [-1,1,1,1,-1,1,1,1] as const) queue.request(direction)
  for (let i=0;i<30 && published.length<8;i++) await tick()
  expect(published).toEqual([0,.04,.12,.14,.12,.14,.3,.3])
})

test("cancel discards stale results and a new step samples the new position", async () => {
  let resolveOld: (frame: FrameStep) => void = () => {}
  let current = 0
  const published: number[] = []
  let calls = 0
  const queue = new FrameStepQueue({ currentTime:()=>current,
    read: async time => ++calls === 1 ? new Promise<FrameStep>(resolve => { resolveOld = resolve }) : step(time + .04),
    publish:frame=>published.push(frame.time),cancelRead:async()=>{},busy:()=>{},error:error=>{throw error},
  })
  queue.request(1); await tick()
  queue.cancel(); current=10; queue.request(1); await tick()
  resolveOld(step(.04)); await tick()
  expect(published).toEqual([10.04])
})

test("failed timestamp lookup never falls back to average fps", async () => {
  const errors: unknown[] = []
  const queue = new FrameStepQueue({currentTime:()=>1,read:async()=>{throw Error("missing timestamps")},publish:()=>{throw Error("must not seek")},cancelRead:async()=>{},busy:()=>{},error:error=>errors.push(error)})
  queue.request(1); queue.request(1); await tick()
  expect(errors).toHaveLength(1)
})

test("new work waits for native cancellation before starting a lookup", async () => {
  let completeCancellation: () => void = () => {}
  const times: number[] = []
  const queue = new FrameStepQueue({
    currentTime: () => 2,
    read: async time => { times.push(time); return step(time + .04) },
    publish: () => {},
    cancelRead: () => new Promise<void>(resolve => { completeCancellation = resolve }),
    busy: () => {},
    error: error => { throw error },
  })
  queue.request(1)
  await tick()
  queue.cancel()
  queue.request(-1)
  await tick()
  expect(times).toEqual([2])
  completeCancellation()
  await tick()
  expect(times).toEqual([2, 2])
})
