"use client"

import * as React from "react"
import { ExternalLink } from "lucide-react"
import type { EmbedData } from "@/hooks/useEmbedPreview"
import { cn } from "@/lib/utils"

type LinkEmbedProps = {
  data: EmbedData
  direction: "in" | "out"
  onLinkClick: (url: string) => void
}

export function LinkEmbed({ data, direction, onLinkClick }: LinkEmbedProps) {
  // Don't render if no useful data
  if (!data.title && !data.description) {
    return null
  }

  const hostname = React.useMemo(() => {
    try {
      return new URL(data.url).hostname
    } catch {
      return null
    }
  }, [data.url])

  return (
    <button
      type="button"
      onClick={() => onLinkClick(data.url)}
      className={cn(
        "mt-2 w-full max-w-sm flex rounded-lg border overflow-hidden text-left transition-colors",
        direction === "out"
          ? "bg-emerald-50/50 border-emerald-200/60 hover:bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800/40 dark:hover:bg-emerald-950/50"
          : "bg-background/50 border-border/60 hover:bg-background/80 dark:bg-slate-800/30 dark:hover:bg-slate-800/50"
      )}
      data-no-action-toggle="true"
    >
      {data.image && (
        <div className="w-20 h-20 flex-shrink-0 bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              // Hide image on error
              (e.target as HTMLImageElement).style.display = "none"
            }}
          />
        </div>
      )}
      <div className="flex-1 min-w-0 p-2.5">
        {(data.siteName || hostname) && (
          <div className="flex items-center gap-1 mb-0.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide truncate">
              {data.siteName || hostname}
            </span>
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground flex-shrink-0" />
          </div>
        )}
        {data.title && (
          <p className="text-xs font-medium leading-snug line-clamp-2">
            {data.title}
          </p>
        )}
        {data.description && (
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug line-clamp-2">
            {data.description}
          </p>
        )}
      </div>
    </button>
  )
}

export function LinkEmbedSkeleton({ direction }: { direction: "in" | "out" }) {
  return (
    <div
      className={cn(
        "mt-2 w-full max-w-sm flex rounded-lg border overflow-hidden animate-pulse",
        direction === "out"
          ? "bg-emerald-50/50 border-emerald-200/60 dark:bg-emerald-950/30 dark:border-emerald-800/40"
          : "bg-background/50 border-border/60 dark:bg-slate-800/30"
      )}
    >
      <div className="w-20 h-20 flex-shrink-0 bg-muted/50" />
      <div className="flex-1 min-w-0 p-2.5 space-y-2">
        <div className="h-2.5 w-16 bg-muted/50 rounded" />
        <div className="h-3 w-full bg-muted/50 rounded" />
        <div className="h-2.5 w-3/4 bg-muted/50 rounded" />
      </div>
    </div>
  )
}
