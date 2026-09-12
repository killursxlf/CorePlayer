export function formatTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, seconds)
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const wholeSeconds = Math.floor(safeSeconds % 60)
  const millis = Math.floor((safeSeconds % 1) * 1000)

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`
}

export function isValidTrimRange(startTime: number, endTime: number | null) {
  return endTime != null && Number.isFinite(startTime) && Number.isFinite(endTime) && startTime >= 0 && endTime > startTime
}

export function parseTimecode(value: string, fps: number): number | null {
  if (!Number.isFinite(fps) || fps <= 0 || !/^\d+:\d{2}:\d{2}:\d{2,3}$/.test(value)) return null
  const [hours, minutes, seconds, frames] = value.split(":").map(Number)
  if (minutes >= 60 || seconds >= 60 || frames >= Math.ceil(fps)) return null
  const time = hours * 3600 + minutes * 60 + seconds + frames / fps
  return Number.isFinite(time) ? time : null
}
