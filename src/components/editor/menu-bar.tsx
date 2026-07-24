"use client"

import { Clapperboard } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type MenuItemConfig = {
  label: string
  shortcut?: string
  onSelect?: () => void
  disabled?: boolean
}

type MenuConfig = {
  label: string
  groups: MenuItemConfig[][]
}

interface MenuBarProps {
  hasMedia: boolean
  hasRecent: boolean
  exportDisabled: boolean
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canDelete: boolean
  timelineVisible: boolean
  inspectorOpen: boolean
  onNewProject: () => void
  onOpenVideo: () => void
  onOpenProject: () => void
  onOpenRecent: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onUndo: () => void
  onRedo: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onDelete: () => void
  onSelectAll: () => void
  canSelectAll: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToScreen: () => void
  onToggleTimeline: () => void
  onToggleInspector: () => void
  onToggleFullscreen: () => void
  onSelectTrimTool: () => void
  onSplitClip: () => void
  onAddMarker: () => void
  onOpenExportSettings: () => void
}

export function MenuBar({
  hasMedia,
  hasRecent,
  exportDisabled,
  canUndo,
  canRedo,
  canCut,
  canCopy,
  canPaste,
  canDelete,
  timelineVisible,
  inspectorOpen,
  onNewProject,
  onOpenVideo,
  onOpenProject,
  onOpenRecent,
  onSave,
  onSaveAs,
  onExport,
  onUndo,
  onRedo,
  onCut,
  onCopy,
  onPaste,
  onDelete,
  onSelectAll,
  canSelectAll,
  onZoomIn,
  onZoomOut,
  onFitToScreen,
  onToggleTimeline,
  onToggleInspector,
  onToggleFullscreen,
  onSelectTrimTool,
  onSplitClip,
  onAddMarker,
  onOpenExportSettings,
}: MenuBarProps) {
  const menus: MenuConfig[] = [
    {
      label: "File",
      groups: [
        [
          { label: "New Project", shortcut: "Ctrl N", onSelect: onNewProject },
          { label: "Open File", shortcut: "Ctrl O", onSelect: onOpenVideo },
          { label: "Open Project", shortcut: "Ctrl Shift O", onSelect: onOpenProject },
          { label: "Open Recent", onSelect: onOpenRecent, disabled: !hasRecent },
        ],
        [
          { label: "Save Project", shortcut: "Ctrl S", onSelect: onSave, disabled: !hasMedia },
          { label: "Save As", shortcut: "Ctrl Shift S", onSelect: onSaveAs, disabled: !hasMedia },
        ],
        [
          { label: "Import Media", onSelect: onOpenVideo },
          { label: "Export", shortcut: "Ctrl E", onSelect: onExport, disabled: exportDisabled || !hasMedia },
        ],
      ],
    },
    {
      label: "Edit",
      groups: [
        [
          { label: "Undo", shortcut: "Ctrl Z", onSelect: onUndo, disabled: !canUndo },
          { label: "Redo", shortcut: "Ctrl Y", onSelect: onRedo, disabled: !canRedo },
        ],
        [
          { label: "Cut", shortcut: "Ctrl X", onSelect: onCut, disabled: !canCut },
          { label: "Copy", shortcut: "Ctrl C", onSelect: onCopy, disabled: !canCopy },
          { label: "Paste", shortcut: "Ctrl V", onSelect: onPaste, disabled: !canPaste },
        ],
        [
          { label: "Delete", shortcut: "Del", onSelect: onDelete, disabled: !canDelete },
          { label: "Select All", shortcut: "Ctrl A", onSelect: onSelectAll, disabled: !canSelectAll },
        ],
      ],
    },
    {
      label: "View",
      groups: [
        [
          { label: "Zoom In", shortcut: "Ctrl +", onSelect: onZoomIn, disabled: !hasMedia },
          { label: "Zoom Out", shortcut: "Ctrl -", onSelect: onZoomOut, disabled: !hasMedia },
          { label: "Fit to Screen", shortcut: "Shift Z", onSelect: onFitToScreen, disabled: !hasMedia },
        ],
        [
          { label: timelineVisible ? "Hide Timeline" : "Show Timeline", onSelect: onToggleTimeline, disabled: !hasMedia },
          { label: inspectorOpen ? "Hide Inspector" : "Show Inspector", onSelect: onToggleInspector },
          { label: "Fullscreen", shortcut: "F11", onSelect: onToggleFullscreen },
        ],
      ],
    },
    {
      label: "Tools",
      groups: [
        [
          { label: "Trim", onSelect: onSelectTrimTool, disabled: !hasMedia },
          { label: "Split", shortcut: "S", onSelect: onSplitClip, disabled: !hasMedia },
          { label: "Add Marker", shortcut: "M", onSelect: onAddMarker, disabled: !hasMedia },
        ],
      ],
    },
    {
      label: "Export",
      groups: [
        [
          { label: "Quick Export", shortcut: "Ctrl E", onSelect: onExport, disabled: exportDisabled || !hasMedia },
          { label: "Export Settings", onSelect: onOpenExportSettings, disabled: !hasMedia },
        ],
      ],
    },
  ]

  return (
    <header className="flex h-9 items-center gap-1 border-b border-border bg-sidebar px-3">
      <div className="mr-2 flex items-center gap-2">
        <div className="flex size-5 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Clapperboard className="size-3" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Lumen</span>
      </div>
      <nav className="flex items-center">
        {menus.map((menu) => (
          <DropdownMenu key={menu.label}>
            <DropdownMenuTrigger className="rounded-md px-2.5 py-1 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent/15 hover:text-foreground data-[popup-open]:bg-accent/15 data-[popup-open]:text-foreground">
              {menu.label}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-52" sideOffset={2}>
              {menu.groups.map((group, gi) => (
                <div key={gi}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  {group.map((item) => (
                    <DropdownMenuItem
                      key={item.label}
                      disabled={item.disabled}
                      onClick={item.disabled ? undefined : item.onSelect}
                    >
                      {item.label}
                      {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </nav>
    </header>
  )
}
