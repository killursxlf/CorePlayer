"use client"

import {
  MousePointer2,
  Move,
  PenTool,
  Brush,
  ArrowUpRight,
  Square,
  Circle,
  Droplet,
  Highlighter,
  Type,
  Crop,
  Ruler,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react"
import type { ToolId } from "@/lib/editor-types"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"

const TOOLS: { id: ToolId; label: string; icon: LucideIcon; key?: string }[] = [
  { id: "select", label: "Select", icon: MousePointer2, key: "V" },
  { id: "move", label: "Move", icon: Move, key: "H" },
  { id: "pen", label: "Pen", icon: PenTool, key: "P" },
  { id: "brush", label: "Brush", icon: Brush, key: "B" },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight, key: "A" },
  { id: "rectangle", label: "Rectangle", icon: Square, key: "R" },
  { id: "circle", label: "Circle", icon: Circle, key: "C" },
  { id: "blur", label: "Blur", icon: Droplet },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "text", label: "Text", icon: Type, key: "T" },
  { id: "crop", label: "Crop", icon: Crop },
  { id: "measure", label: "Measure", icon: Ruler },
]

interface ToolSidebarProps {
  annotationsDisabled?: boolean
  active: ToolId
  onSelect: (id: ToolId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function ToolSidebar({ active, onSelect, collapsed, onToggleCollapse, annotationsDisabled }: ToolSidebarProps) {
  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border bg-sidebar py-2 transition-all duration-200",
        collapsed ? "w-12" : "w-44",
      )}
    >
      <div className={cn("flex items-center px-2 pb-1", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && (
          <span className="pl-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Tools
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
          aria-label={collapsed ? "Expand tools" : "Collapse tools"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <Separator className="my-1" />

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {TOOLS.map((tool) => {
          const Icon = tool.icon
          const isActive = active === tool.id
          const button = (
            <button
              type="button"
              disabled={annotationsDisabled && tool.id !== "select"}
              onClick={() => onSelect(tool.id)}
              className={cn(
                "group flex items-center rounded-lg text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none",
                collapsed ? "size-8 justify-center" : "h-9 w-full gap-2.5 px-2.5",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/15 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="flex-1 text-left">{tool.label}</span>}
              {!collapsed && tool.key && (
                <kbd
                  className={cn(
                    "rounded border px-1 font-mono text-[10px]",
                    isActive
                      ? "border-primary-foreground/30 text-primary-foreground/80"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {tool.key}
                </kbd>
              )}
            </button>
          )

          if (collapsed) {
            return (
              <Tooltip key={tool.id}>
                <TooltipTrigger render={button} />
                <TooltipContent side="right">
                  {tool.label}
                  {tool.key ? ` (${tool.key})` : ""}
                </TooltipContent>
              </Tooltip>
            )
          }
          return <div key={tool.id}>{button}</div>
        })}
      </nav>
    </aside>
  )
}
