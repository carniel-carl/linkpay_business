"use client"

import { useState } from "react"
import { Download, ExternalLink, FileText, FileX2, ImageIcon } from "lucide-react"
import { DocumentStatus } from "@/components/onboarding/document-dropzone"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { KybDocument } from "@/lib/api/types"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"

export type ViewerDocument = KybDocument & { label: string; url: string }

/** Document list plus an inline preview (PDF in an iframe, images scaled to fit). */
export function DocumentViewer({ documents }: { documents: ViewerDocument[] }) {
  const [selectedId, setSelectedId] = useState(documents[0]?._id)
  const selected = documents.find((d) => d._id === selectedId)

  if (!documents.length) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileX2 aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No documents uploaded</EmptyTitle>
          <EmptyDescription>This business hasn&apos;t uploaded anything yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid">
      <ul className="grid gap-1 border-b p-2" aria-label="Documents">
        {documents.map((d) => {
          const active = d._id === selectedId
          const Icon = d.mimeType === "application/pdf" ? FileText : ImageIcon
          return (
            <li key={d._id}>
              <button
                type="button"
                aria-pressed={active}
                aria-controls="document-preview"
                onClick={() => setSelectedId(d._id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
                <DocumentStatus status={d.status} />
              </button>
            </li>
          )
        })}
      </ul>

      {selected && (
        <div id="document-preview" role="region" aria-label={`Preview: ${selected.label}`}>
          <div className="flex items-center gap-3 border-b px-4 py-2 sm:px-5">
            <div className="grid min-w-0 flex-1">
              <span className="truncate text-sm font-medium">{selected.originalName}</span>
              <span className="text-xs text-muted-foreground figure">{formatBytes(selected.size)}</span>
            </div>
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={selected.url} target="_blank" rel="noreferrer" aria-label={`Open ${selected.label} in a new tab`}>
                <ExternalLink />
              </a>
            </Button>
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={`${selected.url}?download=1`} aria-label={`Download ${selected.label}`}>
                <Download />
              </a>
            </Button>
          </div>
          <div className="bg-muted/50">
            {selected.mimeType === "application/pdf" ? (
              <iframe key={selected._id} src={selected.url} title={selected.label} className="h-[65vh] w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- authenticated proxy URL, not optimisable
              <img
                key={selected._id}
                src={selected.url}
                alt={selected.label}
                className="mx-auto max-h-[65vh] w-auto object-contain"
              />
            )}
          </div>
          {selected.rejectionReason && (
            <p className="border-t px-4 py-2 text-sm text-warning-foreground sm:px-5">Previous note: {selected.rejectionReason}</p>
          )}
        </div>
      )}
    </div>
  )
}
