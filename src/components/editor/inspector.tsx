"use client"

import { parseTimecode } from "@/utils/time"
import { Info, SlidersHorizontal, Eye, EyeOff, Trash2, X } from "lucide-react"
import type { Annotation, VideoInfo } from "@/lib/editor-types"
import { ANNOTATION_NAMES, formatClock, formatTimecode } from "@/lib/editor-types"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#eab308", "#a855f7", "#ffffff"]
const FONTS = ["Inter", "Geist", "Roboto", "Arial", "Mono"]

interface InspectorProps {
  videoInfo: VideoInfo
  selected: Annotation | null
  onEditStart: () => void
  onEditEnd: () => void
  onChange: (patch: Partial<Annotation>) => void
  onDelete: () => void
  onClose: () => void
}

function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground" title={title}>
        {value}
      </span>
    </div>
  )
}

function formatFps(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return "Unknown"
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`
}

function formatInfoValue(value: string) {
  const trimmed = value.trim()
  return trimmed && trimmed !== "N/A" ? trimmed : "Unknown"
}

function formatCodecValue(value: string) {
  const codec = formatInfoValue(value)
  const normalized = codec.toLowerCase()
  if (codec === "Unknown") return codec
  if (normalized.includes("h.264") || normalized.includes("avc")) return "H.264 / AVC"
  if (normalized.includes("h.265") || normalized.includes("hevc")) return "H.265 / HEVC"
  if (normalized.includes("av1")) return "AV1"
  if (normalized.includes("vp9")) return "VP9"
  if (normalized.includes("vp8")) return "VP8"
  if (normalized.includes("mpeg-2")) return "MPEG-2"
  if (normalized.includes("prores")) return "Apple ProRes"
  return codec
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

export function Inspector({ videoInfo, selected, onEditStart, onEditEnd, onChange, onDelete, onClose }: InspectorProps) {
  return (
    <aside onPointerDownCapture={onEditStart} onFocusCapture={onEditStart} onBlurCapture={onEditEnd} className="flex w-72 flex-col border-l border-border bg-sidebar">
      <div className="flex h-10 items-center gap-2 border-b border-border px-4">
        {selected ? (
          <SlidersHorizontal className="size-4 text-primary" />
        ) : (
          <Info className="size-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{selected ? "Свойства" : "Inspector"}</span>
        {selected && (
          <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {ANNOTATION_NAMES[selected.type]}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
          aria-label="Close inspector"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!selected ? (
          <>
            <Section title="Media">
              <InfoRow label="Filename" value={videoInfo.filename} />
              <Separator className="my-0.5" />
              <InfoRow label="Duration" value={formatClock(videoInfo.duration)} />
              <Separator className="my-0.5" />
              <InfoRow
                label="Codec"
                value={formatCodecValue(videoInfo.codec)}
                title={formatInfoValue(videoInfo.codec)}
              />
              <Separator className="my-0.5" />
              <InfoRow label="Resolution" value={videoInfo.resolution} />
              <Separator className="my-0.5" />
              <InfoRow label="Frame Rate" value={videoInfo.fpsKnown ? formatFps(videoInfo.fps) : "Unknown"} />
              <Separator className="my-0.5" />
              <InfoRow label="Bitrate" value={formatInfoValue(videoInfo.bitrate)} />
            </Section>
            <Section title="Audio">
              <InfoRow label="Streams" value={videoInfo.audioStreams} />
            </Section>
            <Section title="Subtitles">
              <InfoRow label="Tracks" value={videoInfo.subtitles} />
            </Section>
            <p className="px-1 pt-1 text-xs leading-relaxed text-muted-foreground">
              Select an annotation on the preview or timeline to edit its properties.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">Перетащите объект в кадре, чтобы изменить положение. На таймлайне тяните полосу для переноса, её края — для изменения длительности.</p>
            <Section title="Внешний вид">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="annotation-label" className="text-xs text-muted-foreground">{selected.type === "text" || selected.type === "measure" ? "Текст в кадре" : "Название на таймлайне"}</Label>
                  <Input id="annotation-label" value={selected.label} onChange={event => { onEditStart(); onChange({label: event.currentTarget.value}) }} />
                </div>
                {selected.type !== "blur" && selected.type !== "crop" && <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Цвет</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onChange({ color: c })}
                        aria-label={`Color ${c}`}
                        className={
                          "size-6 rounded-full ring-2 ring-offset-2 ring-offset-sidebar transition-transform hover:scale-110 " +
                          (selected.color.toLowerCase() === c ? "ring-foreground" : "ring-transparent")
                        }
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Непрозрачность</Label>
                    <span className="font-mono text-xs tabular-nums text-foreground">{selected.opacity}%</span>
                  </div>
                  <Slider
                    value={[selected.opacity]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(v) => onChange({ opacity: Array.isArray(v) ? v[0] : v })}
                  />
                </div>

                {selected.type !== "crop" && selected.type !== "highlight" && <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">{selected.type === "blur" ? "Сила размытия" : selected.type === "text" ? "Размер текста" : "Толщина"}</Label>
                    <span className="font-mono text-xs tabular-nums text-foreground">{selected.thickness}px</span>
                  </div>
                  <Slider
                    value={[selected.thickness]}
                    min={1}
                    max={24}
                    step={1}
                    onValueChange={(v) => onChange({ thickness: Array.isArray(v) ? v[0] : v })}
                  />
                </div>}

                {selected.type === "text" && <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Шрифт</Label>
                  <Select value={selected.font} onValueChange={(v) => v && onChange({ font: v })}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONTS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>}

                <div className="flex items-center justify-between rounded-lg bg-secondary/50 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    {selected.visible ? (
                      <Eye className="size-4 text-muted-foreground" />
                    ) : (
                      <EyeOff className="size-4 text-muted-foreground" />
                    )}
                    <Label className="text-sm">Показывать в кадре</Label>
                  </div>
                  <Switch
                    aria-label="Показывать объект в кадре"
                    checked={selected.visible}
                    onCheckedChange={(v) => onChange({ visible: v })}
                  />
                </div>
              </div>
            </Section>

            <Section title="Время на таймлайне">
              <p className="mb-2 text-xs text-muted-foreground">{selected.type === "crop" ? "Кадрирование применяется ко всему ролику." : `Длительность: ${(selected.endTime - selected.startTime).toFixed(2)} с · чч:мм:сс:кадр`}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Начало</Label>
                  <Input
                    key={selected.id + ":startTime:" + selected.startTime}
                    aria-label="Annotation start time"
                    defaultValue={formatTimecode(selected.startTime, videoInfo.fps)}
                    disabled={selected.type === "crop"}
                    onBlur={event => {
                      const time = parseTimecode(event.currentTarget.value, videoInfo.fps)
                      if (time !== null && time >= 0 && time <= selected.endTime - 0.001 && time !== selected.startTime) onChange({startTime: time})
                      else event.currentTarget.value = formatTimecode(selected.startTime, videoInfo.fps)
                    }}
                    onKeyDown={event => {
                      if (event.key === "Escape") event.currentTarget.value = formatTimecode(selected.startTime, videoInfo.fps)
                      if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur()
                    }}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Конец</Label>
                  <Input
                    key={selected.id + ":endTime:" + selected.endTime}
                    aria-label="Annotation end time"
                    defaultValue={formatTimecode(selected.endTime, videoInfo.fps)}
                    disabled={selected.type === "crop"}
                    onBlur={event => {
                      const time = parseTimecode(event.currentTarget.value, videoInfo.fps)
                      if (time !== null && time >= selected.startTime + 0.001 && time <= videoInfo.duration && time !== selected.endTime) onChange({endTime: time})
                      else event.currentTarget.value = formatTimecode(selected.endTime, videoInfo.fps)
                    }}
                    onKeyDown={event => {
                      if (event.key === "Escape") event.currentTarget.value = formatTimecode(selected.endTime, videoInfo.fps)
                      if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur()
                    }}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
            </Section>

            <Button
              variant="ghost"
              className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              Удалить объект
            </Button>
          </>
        )}
      </div>
    </aside>
  )
}
