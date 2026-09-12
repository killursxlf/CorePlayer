import { useEffect, useState } from "react"
import { getMediaService } from "@/services/media-service-provider"
import { usePerformanceStore } from "@/stores/performance-store"
import type { AccelerationSettings, AccelerationStatus } from "@/types/media"

export function AccelerationSettingsPanel() {
  const [status, setStatus] = useState<AccelerationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const config = usePerformanceStore(state => state.config)
  const service = getMediaService()
  const current = config?.acceleration ?? status

  useEffect(() => {
    let disposed = false
    void service.detectAccelerators().then(async value => {
      if (disposed) return
      setStatus(value)
      usePerformanceStore.getState().setConfig(await service.getRuntimePerformanceConfig())
    }).catch(error => { if (!disposed) setError(String(error)) })
    const timer = window.setInterval(() => {
      void service.getRuntimePerformanceConfig().then(value => {
        if (!disposed) usePerformanceStore.getState().setConfig(value)
      }).catch(() => undefined)
    }, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [service])

  async function refresh() {
    setBusy(true)
    setError("")
    try {
      setStatus(await service.detectAccelerators())
      usePerformanceStore.getState().setConfig(await service.getRuntimePerformanceConfig())
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }

  async function change(settings: AccelerationSettings) {
    setBusy(true)
    setError("")
    try {
      await service.setAccelerationSettings(settings)
      usePerformanceStore.getState().setConfig(await service.getRuntimePerformanceConfig())
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }

  const selected = current?.settings ?? { mode: "auto", deviceId: null }
  const devices = current?.devices ?? []
  const usage = Object.values(current?.usage ?? {})
  const activeUsage = current?.usage[config?.exportActive ? "export" : "playback"]
  return <details className="relative">
    <summary className="max-w-60 cursor-pointer truncate" aria-label="Настройки аппаратного ускорения"
      title={activeUsage ? `${activeUsage.accelerator}${activeUsage.reason ? `: ${activeUsage.reason}` : ""}` : undefined}>
      {activeUsage?.accelerator ?? `Ускорение: ${selected.mode === "auto" ? "Авто" : selected.mode.toUpperCase()}`}
    </summary>
    <div className="absolute bottom-7 right-0 z-50 grid max-h-[75vh] w-[430px] gap-3 overflow-auto rounded border border-border bg-popover p-4 font-sans text-xs text-popover-foreground shadow-lg">
      <strong>Аппаратное ускорение</strong>
      <label className="grid gap-1">Обработка видео
        <select className="rounded border bg-background p-1" value={selected.mode} disabled={busy}
          onChange={event => void change({ ...selected, mode: event.target.value as AccelerationSettings["mode"] })}>
          <option value="auto">Авто</option><option value="gpu">GPU</option><option value="cpu">CPU</option>
        </select>
      </label>
      <label className="grid gap-1">Устройство FFmpeg
        <select className="rounded border bg-background p-1" value={selected.deviceId ?? ""} disabled={busy || selected.mode === "cpu"}
          onChange={event => void change({ ...selected, deviceId: event.target.value || null })}>
          <option value="">Автоматический выбор</option>
          {selected.deviceId && !devices.some(device => device.id === selected.deviceId) &&
            <option value={selected.deviceId}>Устройство недоступно</option>}
          {devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
        </select>
      </label>
      <button className="rounded border p-1 disabled:opacity-50" disabled={busy || config?.playbackActive || config?.exportActive}
        onClick={() => void refresh()}>{busy ? "Проверка…" : "Проверить оборудование повторно"}</button>
      {!current?.checked && <p>Проверка устройств и кодеков…</p>}
      {current?.checked && devices.length === 0 && <p>Работоспособный GPU не найден. Используется CPU.</p>}
      {current?.diagnostic && <p>{current.diagnostic}</p>}
      {devices.map(device => <details key={device.id}>
        <summary>{device.name}</summary>
        <p>Кодирование: {device.encoders.join(", ") || "нет"}</p>
        <p>Декодирование (проверенные образцы 8-bit): {device.decoders.join(", ") || "нет"}</p>
        {device.diagnostics.length > 0 && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{device.diagnostics.join("\n")}</pre>}
      </details>)}
      {current && (selected.mode === "cpu") !== current.playbackCpu &&
        <p role="status">Настройки сохранены. Перезапустите приложение, чтобы применить режим CPU/GPU к воспроизведению.</p>}
      <p>Адаптер воспроизведения выбирает Windows. Выбранное выше устройство применяется к миниатюрам, прокси и экспорту.</p>
      <p>Одна фоновая GPU-задача. Во время воспроизведения GPU освобождается для плеера.</p>
      {usage.map(item => <div key={item.task} className="break-words">
        <strong>{({ playback: "Воспроизведение", export: "Экспорт", proxy: "Прокси", thumbnails: "Миниатюры" } as Record<string, string>)[item.task] ?? item.task}: </strong>
        {item.accelerator}{item.reason && <p className="text-muted-foreground">{item.reason}</p>}
      </div>)}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>
}
