"use client"

import { useState } from "react"
import { AlertTriangle, ChevronDown, X } from "lucide-react"
import type { AppError } from "@/types/app-error"

interface ErrorNoticeProps {
  error: AppError
  onDismiss: () => void
}

export function ErrorNotice({ error, onDismiss }: ErrorNoticeProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-foreground">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{error.title}</div>
          <div className="text-muted-foreground">{error.message}</div>
          {error.technicalDetails && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setDetailsOpen((open) => !open)}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`size-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
                Show details
              </button>
              {detailsOpen && (
                <pre className="mt-1 max-h-24 overflow-auto rounded-md bg-background/70 p-2 text-xs text-muted-foreground">
                  {error.technicalDetails}
                </pre>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-foreground"
          aria-label="Dismiss error"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
