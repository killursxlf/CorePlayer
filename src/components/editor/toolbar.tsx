"use client"

import {
  FolderOpen,
  Save,
  Upload,
  XCircle,
  Undo2,
  Redo2,
  Scissors,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface ToolbarProps {
  hasMedia: boolean
  zoom: number
  onZoomChange: (v: number) => void
  onOpenVideo: () => void
  onExport: () => void
  onCancelExport: () => void
  exportRunning: boolean
  exportDisabled: boolean
  onSave: () => void
  onSplitClip: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            onClick={onClick}
            disabled={disabled}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Toolbar({
  hasMedia,
  zoom,
  onZoomChange,
  onOpenVideo,
  onExport,
  onCancelExport,
  exportRunning,
  exportDisabled,
  onSave,
  onSplitClip,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: ToolbarProps) {
  return (
    <div className="flex h-12 items-center gap-1 border-b border-border bg-card px-3">
      <IconButton label="Open Video" onClick={onOpenVideo}>
        <FolderOpen className="size-4" />
      </IconButton>
      <IconButton label="Save Project" onClick={onSave} disabled={!hasMedia}>
        <Save className="size-4" />
      </IconButton>
      <IconButton label="Export Clips" onClick={onExport} disabled={exportDisabled}>
        <Upload className={`size-4 ${exportDisabled ? "opacity-40" : ""}`} />
      </IconButton>
      {exportRunning && (
        <IconButton label="Cancel Export" onClick={onCancelExport}>
          <XCircle className="size-4 text-destructive" />
        </IconButton>
      )}

      <Separator orientation="vertical" className="mx-1.5 h-5" />

      <IconButton label="Split at playhead (S)" onClick={onSplitClip} disabled={!hasMedia}>
        <Scissors className="size-4" />
      </IconButton>

      <Separator orientation="vertical" className="mx-1.5 h-5" />

      <IconButton label="Undo" onClick={onUndo} disabled={!canUndo}>
        <Undo2 className="size-4" />
      </IconButton>
      <IconButton label="Redo" onClick={onRedo} disabled={!canRedo}>
        <Redo2 className="size-4" />
      </IconButton>

      <Separator orientation="vertical" className="mx-1.5 h-5" />

      {/* Zoom */}
      <div className="flex items-center gap-2 rounded-lg bg-secondary/60 px-2 py-1">
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(25, zoom - 25))}
          disabled={!hasMedia}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Zoom out"
        >
          <ZoomOut className="size-4" />
        </button>
        <Slider
          value={[zoom]}
          min={25}
          max={400}
          step={5}
          onValueChange={(v) => onZoomChange(Array.isArray(v) ? v[0] : v)}
          disabled={!hasMedia}
          className="w-28"
          aria-label="Zoom level"
        />
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(400, zoom + 25))}
          disabled={!hasMedia}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Zoom in"
        >
          <ZoomIn className="size-4" />
        </button>
        <span className="w-11 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {zoom}%
        </span>
      </div>
    </div>
  )
}
