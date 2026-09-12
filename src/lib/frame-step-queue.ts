import type { FrameStep } from "@/types/media"

type Direction = -1 | 1
type Options = {
  currentTime: () => number
  read: (time: number, direction: Direction) => Promise<FrameStep>
  publish: (step: FrameStep) => void
  cancelRead: () => Promise<void>
  busy: (value: boolean) => void
  error: (error: unknown) => void
}

/** Ordered clicks advance from the requested frame, even before its seek completes. */
export class FrameStepQueue {
  private directions: Direction[] = []
  private cursor: number | null = null
  private epoch = 0
  private running = false
  private barrier = Promise.resolve()
  private options: Options
  constructor(options: Options) { this.options = options }

  request(direction: Direction) {
    if (this.directions.length >= 128) {
      this.options.error(new Error("Too many pending frame steps. Wait for the preview to catch up."))
      return
    }
    this.directions.push(direction)
    if (!this.running) void this.pump()
  }

  cancel() {
    const hadWork = this.running || this.cursor !== null
    this.epoch++
    this.running = false
    this.directions = []
    this.cursor = null
    this.options.busy(false)
    if (hadWork) this.barrier = this.options.cancelRead().catch(() => undefined)
  }

  private async pump() {
    const epoch = this.epoch
    this.running = true
    this.options.busy(true)
    // Sample the displayed frame before awaiting IPC/cancellation.
    this.cursor ??= this.options.currentTime()
    try {
      await this.barrier
      while (epoch === this.epoch && this.directions.length) {
        const direction = this.directions.shift()!
        const step = await this.options.read(this.cursor!, direction)
        if (epoch !== this.epoch) return
        if (!Number.isFinite(step.time) || !Number.isFinite(step.seekTime) || step.time < 0) throw new Error("Invalid frame timestamp.")
        this.cursor = step.time
        this.options.publish(step)
      }
    } catch (error) {
      if (epoch !== this.epoch) return
      this.directions = []
      this.cursor = null
      this.options.error(error)
    } finally {
      if (epoch === this.epoch) { this.running = false; this.options.busy(false) }
    }
  }
}
