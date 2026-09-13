import { useEffect, useState } from "react"
import { CheckCircle2, CircleAlert, LoaderCircle, X } from "lucide-react"
import type { ExportStatus } from "@/types/media"

export type ExportFeedback = {
  startedAt: number
  updatedAt: number
  advancedAt: number
  sampleAt: number | null
  sampleProgress: number
  progress: number
  message: string
  outputPath: string
  cancelling: boolean
}

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`
}

export function ExportProgressPanel({ status, progress, feedback, canCancel, onCancel, onClose }: {
  status: ExportStatus
  progress: number
  feedback: ExportFeedback
  canCancel: boolean
  onCancel: () => void
  onClose: () => void
}) {
  const running = status === "preparing" || status === "exporting"
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const elapsed = ((running ? now : feedback.updatedAt) - feedback.startedAt) / 1000
  const quiet = running && status === "exporting" && now - feedback.advancedAt >= 15000
  const sampleSeconds = feedback.sampleAt === null ? 0 : (now - feedback.sampleAt) / 1000
  const advanced = progress - feedback.sampleProgress
  const remaining = sampleSeconds >= 3 && advanced >= 0.01 && progress < 0.99 && !quiet
    ? Math.ceil(sampleSeconds * (1 - progress) / advanced) : null
  const percent = status === "completed" ? 100 : Math.min(99, Math.floor(progress * 100))
  const finishing = running && progress >= 0.99
  const title = feedback.cancelling && running ? "Отмена экспорта…"
    : status === "preparing" ? "Подготовка экспорта…"
    : finishing ? "Сохранение результата…"
    : status === "exporting" ? "Экспорт видео"
    : status === "completed" ? "Экспорт завершён"
    : status === "cancelled" ? "Экспорт отменён" : "Не удалось экспортировать"

  return <section aria-label="Прогресс экспорта" className="fixed bottom-10 right-4 z-[60] w-[min(400px,calc(100vw-32px))] rounded-xl border border-border bg-card p-4 shadow-2xl">
    <div className="flex items-center gap-2">
      {running ? <LoaderCircle className="size-5 shrink-0 animate-spin text-primary" />
        : status === "completed" ? <CheckCircle2 className="size-5 text-emerald-400" /> : <CircleAlert className="size-5 text-muted-foreground" />}
      <h2 role="status" className="flex-1 text-sm font-semibold">{title}</h2>
      {!running && <button type="button" aria-label="Закрыть прогресс экспорта" onClick={onClose} className="rounded p-1 hover:bg-secondary"><X className="size-4" /></button>}
    </div>
    <div className="mt-4 flex items-baseline justify-between gap-3">
      <span className="truncate text-xs text-muted-foreground" title={feedback.message}>{finishing ? "Запись контейнера и публикация файла" : feedback.message.replace(/^Exporting /, "Обрабатывается: ")}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums">{percent}%</span>
    </div>
    <progress aria-label="Готовность экспорта" value={progress} max={1} className="mt-2 h-2 w-full overflow-hidden rounded-full accent-primary" />
    <div className="mt-3 flex justify-between gap-3 text-xs tabular-nums text-muted-foreground">
      <span>Прошло {clock(elapsed)}</span>
      {running && <span>{remaining === null ? finishing ? "Завершаем…" : "Оцениваем время…" : `Осталось около ${clock(remaining)}`}</span>}
    </div>
    {quiet && !feedback.cancelling && <p className="mt-3 text-xs text-amber-400">Прогресс не менялся {Math.floor((now - feedback.advancedAt) / 1000)} с. {finishing ? "Идёт завершение файла." : "Кодировщик пока не сообщил о продвижении."}</p>}
    {feedback.outputPath && <p className="mt-3 truncate text-xs text-muted-foreground" title={feedback.outputPath}>{feedback.outputPath}</p>}
    {running && <button type="button" onClick={onCancel} disabled={!canCancel || feedback.cancelling} className="mt-4 w-full rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50">{feedback.cancelling ? "Ожидаем остановки…" : "Отменить экспорт"}</button>}
  </section>
}
