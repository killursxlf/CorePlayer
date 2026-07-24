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
  return endTime != null && startTime >= 0 && endTime > startTime
}
