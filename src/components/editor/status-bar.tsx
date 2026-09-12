"use client"

import { Play, Pause, Upload, Check, CircleDot } from "lucide-react"
import { AccelerationSettingsPanel } from "./acceleration-settings-panel"

interface StatusBarProps {
  hasMedia: boolean
  currentFrame: number
  variableFps?: boolean
  currentTime: number
  fps: number
  isPlaying: boolean
  saved: boolean
  exportStatus: string
  exportProgress: number
}

function Item({
  icon,
  children,
  tone = "muted",
}: {
  icon?: React.ReactNode
  children: React.ReactNode
  tone?: "muted" | "active" | "warn"
}) {
  const toneClass =
    tone === "active" ? "text-chart-3" : tone === "warn" ? "text-chart-4" : "text-muted-foreground"
  return (
    <div className={`flex items-center gap-1.5 ${toneClass}`}>
      {icon}
      <span>{children}</span>
    </div>
  )
}

export function StatusBar({
  hasMedia,
  currentFrame,
  variableFps,
  currentTime,
  fps,
  isPlaying,
  saved,
  exportStatus,
  exportProgress,
}: StatusBarProps) {
  return (
    <footer className="flex h-7 items-center gap-4 border-t border-border bg-sidebar px-4 font-mono text-[11px] tabular-nums">
      {!hasMedia ? (
        <Item>No media loaded</Item>
      ) : (
        <>
          <Item>{variableFps ? `Time ${currentTime.toFixed(6)} s` : `Frame ${currentFrame}`}</Item>
          <div className="h-3 w-px bg-border" />
          <Item>{fps.toFixed(2)} fps{variableFps ? " (variable)" : ""}</Item>
        </>
      )}
      <div className="h-3 w-px bg-border" />
      <Item
        icon={isPlaying ? <Play className="size-3" /> : <Pause className="size-3" />}
        tone={isPlaying ? "active" : "muted"}
      >
        {isPlaying ? "Playing" : "Paused"}
      </Item>

      <div className="ml-auto flex items-center gap-4">
        <AccelerationSettingsPanel />
        <Item icon={<Upload className="size-3" />} tone={exportStatus === "Ready" ? "muted" : "warn"}>
          Export: {exportStatus}
          {exportStatus !== "Ready" && ` ${Math.round(exportProgress * 100)}%`}
        </Item>
        <Item
          icon={saved ? <Check className="size-3" /> : <CircleDot className="size-3" />}
          tone={saved ? "active" : "warn"}
        >
          {saved ? "Saved" : "Unsaved"}
        </Item>
      </div>
    </footer>
  )
}
