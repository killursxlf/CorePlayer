"use client"

import { compatibleExportSettings } from "@/lib/export-settings"
import { X } from "lucide-react"
import type { TimelineClip } from "@/lib/editor-types"
import type { ExportSettings } from "@/types/export"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type ExportScope = "timeline" | "selected" | "all"

interface ExportSettingsPanelProps {
  open: boolean
  clips: TimelineClip[]
  selectedClipId: string | null
  selectedClipIds: string[]
  settings: ExportSettings
  scope: ExportScope
  exportRunning: boolean
  onSettingsChange: (settings: ExportSettings) => void
  onScopeChange: (scope: ExportScope) => void
  onClose: () => void
  onExport: () => void
}

const formats = ["mp4", "mov", "mkv", "webm"] as const
const videoCodecs = ["copy", "h264", "h265", "av1", "vp9"] as const
const audioCodecs = ["copy", "aac", "opus", "mp3"] as const
const presets = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"] as const

function numberValue(value: number | null) {
  return value == null ? "" : String(value)
}

function parseOptionalNumber(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function ExportSettingsPanel({
  open,
  clips,
  selectedClipId,
  selectedClipIds,
  settings,
  scope,
  exportRunning,
  onSettingsChange,
  onScopeChange,
  onClose,
  onExport,
}: ExportSettingsPanelProps) {
  if (!open) return null

  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? clips[0]
  const selectedSet = new Set(selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [])
  const selectedClips = clips.filter((clip) => selectedSet.has(clip.id))
  const exportCount = scope !== "selected" ? clips.length : selectedClips.length
  const update = (patch: Partial<ExportSettings>) => onSettingsChange(compatibleExportSettings({ ...settings, ...patch }))

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <section className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex h-11 items-center gap-3 border-b border-border px-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Export settings</h2>
            <p className="text-xs text-muted-foreground">
              {exportCount} clip{exportCount === 1 ? "" : "s"} ready
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/15 hover:text-foreground"
            aria-label="Close export settings"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid gap-4 overflow-y-auto p-4 md:grid-cols-2">
          <div className="space-y-3">
            <Field label="Scope">
              <select
                value={scope}
                onChange={(event) => onScopeChange(event.currentTarget.value as ExportScope)}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="timeline">Весь монтаж одним файлом</option>
                <option value="selected">Selected clips</option>
                <option value="all">All clips as separate files</option>
              </select>
            </Field>

            <Field label="Format">
              <select
                value={settings.format}
                onChange={(event) => update({ format: event.currentTarget.value as ExportSettings["format"] })}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                {formats.map((format) => (
                  <option key={format} value={format}>
                    {format.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Mode">
              <select
                value={settings.mode}
                onChange={(event) => update({ mode: event.currentTarget.value as ExportSettings["mode"] })}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="stream-copy" disabled={settings.format === "webm"}>Fast stream copy (keyframe cuts)</option>
                <option value="encode">Encode with settings</option>
              </select>
            </Field>

            <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-5 text-muted-foreground">
              {scope === "timeline" && <p className="mb-2">Монтаж экспортируется одним файлом с аннотациями и всеми аудиодорожками. Разрывы сохраняются как чёрный экран и тишина. Видео и звук перекодируются; COPY автоматически заменяется совместимым кодировщиком.</p>}
              Encode for precise cuts. Stream copy starts near a keyframe and may include extra footage.
              Video codec COPY has the same limitation. Annotations require video re-encoding in either mode.
              All audio streams are retained; source subtitles are not included. Crop applies to the whole clip.
              Multiple clips produce separate files; use a new name if those files already exist.
            </div>
          </div>

          <div className="space-y-3">
            <Field label="Video codec">
              <select
                value={settings.videoCodec}
                onChange={(event) => update({ videoCodec: event.currentTarget.value as ExportSettings["videoCodec"] })}
                disabled={settings.mode === "stream-copy"}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50"
              >
                {videoCodecs.filter(codec => settings.format !== "webm" || codec === "vp9" || codec === "av1").map((codec) => (
                  <option key={codec} value={codec}>
                    {codec.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Audio codec">
              <select
                value={settings.audioCodec}
                onChange={(event) => update({ audioCodec: event.currentTarget.value as ExportSettings["audioCodec"] })}
                disabled={settings.mode === "stream-copy"}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50"
              >
                {audioCodecs.filter(codec => settings.format !== "webm" || codec === "opus").map((codec) => (
                  <option key={codec} value={codec}>
                    {codec.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Video bitrate">
                <Input
                  value={numberValue(settings.videoBitrateKbps)}
                  onChange={(event) => update({ videoBitrateKbps: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="kbps"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
              <Field label="Audio bitrate">
                <Input
                  value={numberValue(settings.audioBitrateKbps)}
                  onChange={(event) => update({ audioBitrateKbps: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="kbps"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="FPS">
                <Input
                  value={numberValue(settings.fps)}
                  onChange={(event) => update({ fps: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="same"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
              <Field label="Width">
                <Input
                  value={numberValue(settings.width)}
                  onChange={(event) => update({ width: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="same"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
              <Field label="Height">
                <Input
                  value={numberValue(settings.height)}
                  onChange={(event) => update({ height: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="same"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="CRF">
                <Input
                  value={numberValue(settings.crf)}
                  onChange={(event) => update({ crf: parseOptionalNumber(event.currentTarget.value) })}
                  placeholder="20"
                  disabled={settings.mode === "stream-copy"}
                />
              </Field>
              <Field label="Preset">
                <select
                  value={settings.preset}
                  onChange={(event) => update({ preset: event.currentTarget.value })}
                  disabled={settings.mode === "stream-copy"}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50"
                >
                  {presets.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {scope === "selected" && selectedClips.length > 1
              ? `${selectedClips.length} clips selected`
              : selectedClip
                ? `${selectedClip.label}: ${selectedClip.startTime.toFixed(2)}s - ${selectedClip.endTime.toFixed(2)}s`
                : "No clip selected"}
          </span>
          <Button className="ml-auto" onClick={onExport} disabled={exportRunning || exportCount === 0}>
            {exportRunning ? "Exporting..." : "Export"}
          </Button>
        </div>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
