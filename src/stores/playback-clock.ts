type PlaybackClockListener = (time: number) => void

let currentTime = 0
const listeners = new Set<PlaybackClockListener>()

export const playbackClock = {
  getSnapshot: () => currentTime,
  set(time: number) {
    if (!Number.isFinite(time) || Math.abs(time - currentTime) < 0.0001) return
    currentTime = Math.max(0, time)
    listeners.forEach((listener) => listener(currentTime))
  },
  subscribe(listener: PlaybackClockListener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
