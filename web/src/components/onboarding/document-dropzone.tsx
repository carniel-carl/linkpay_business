"use client"

import { useId, useRef, useState, useTransition } from "react"
import { Eye, FileText, MoreHorizontal, RefreshCw, Trash2, TriangleAlert, Upload } from "lucide-react"
import { toast } from "sonner"
import { deleteDocument, uploadDocument } from "@/app/(onboarding)/onboarding/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { KybDocument } from "@/lib/api/types"
import { formatBytes, formatDate } from "@/lib/format"
import { ACCEPTED_FILE_TYPES, MAX_UPLOAD_BYTES, type DocumentType } from "@/lib/kyb"
import { cn } from "@/lib/utils"

type Props = {
  type: DocumentType
  personId?: string
  label: string
  description?: string
  document?: KybDocument
  editable?: boolean
  /** Smaller variant used inline under a person. */
  compact?: boolean
}

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"

function validate(file: File) {
  if (!ACCEPTED_FILE_TYPES.includes(file.type as (typeof ACCEPTED_FILE_TYPES)[number])) {
    return "Upload a PDF, PNG or JPEG file."
  }
  if (file.size > MAX_UPLOAD_BYTES) return "That file is over 5 MB. Upload a smaller file."
  return null
}

export function DocumentDropzone({ type, personId, label, description, document: fromServer, editable = true, compact }: Props) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, startRemove] = useTransition()
  // The action's own response is newer than the page props until the refreshed tree arrives
  // (several uploads in a row can lag). Use it until the server's document changes.
  const [override, setOverride] = useState<{ doc: KybDocument | null; basedOn?: string } | null>(null)
  const document = override && override.basedOn === fromServer?._id ? (override.doc ?? undefined) : fromServer

  async function upload(file: File) {
    const problem = validate(file)
    if (problem) return setError(problem)
    setError(null)
    setUploading(file.name)
    const data = new FormData()
    data.set("type", type)
    if (personId) data.set("personId", personId)
    data.set("file", file)
    const result = await uploadDocument(data)
    setUploading(null)
    if (result.ok) {
      const doc = result.data.documents.find((d) => d.type === type && (d.person ?? undefined) === personId)
      setOverride({ doc: doc ?? null, basedOn: fromServer?._id })
      toast.success(`${compact ? "ID" : label} uploaded.`)
    } else setError(result.error)
  }

  function onFiles(files: FileList | null) {
    const file = files?.[0]
    if (file) void upload(file)
    if (inputRef.current) inputRef.current.value = ""
  }

  function remove() {
    if (!document) return
    startRemove(async () => {
      const result = await deleteDocument(document._id)
      if (result.ok) {
        setOverride({ doc: null, basedOn: fromServer?._id })
        toast.success("File removed.")
      }
      else toast.error(result.error)
    })
  }

  const browse = () => inputRef.current?.click()
  const rejected = document?.status === "rejected"

  const dropHandlers = editable
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(true)
        },
        onDragLeave: () => setDragging(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(false)
          onFiles(e.dataTransfer.files)
        },
      }
    : {}

  return (
    <div className="grid gap-2" {...dropHandlers}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => onFiles(e.target.files)}
      />

      {uploading ? (
        <div className={cn("flex items-center gap-3 rounded-xl border bg-muted/40", compact ? "p-2.5" : "p-3.5")}>
          <Spinner className="text-primary" />
          <span className="min-w-0 truncate text-sm">Uploading {uploading}</span>
        </div>
      ) : document ? (
        <div
          className={cn(
            "surface flex items-center gap-3 transition-colors duration-150",
            compact ? "p-2.5" : "p-3.5",
            rejected && "border-warning/50 bg-warning-subtle/50",
            dragging && "border-primary bg-brand-subtle",
          )}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FileText className="size-4" aria-hidden />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm font-medium">{document.originalName}</span>
            <span className="text-xs text-muted-foreground figure">
              {formatBytes(document.size)}, uploaded {formatDate(document.createdAt)}
            </span>
          </div>
          <DocumentStatus status={document.status} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`} disabled={removing}>
                {removing ? <Spinner /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={`/api/files/business/${document._id}`} target="_blank" rel="noreferrer">
                  <Eye aria-hidden /> View file
                </a>
              </DropdownMenuItem>
              {editable && (
                <>
                  <DropdownMenuItem onSelect={browse}>
                    <RefreshCw aria-hidden /> Replace
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={remove}>
                    <Trash2 aria-hidden /> Remove
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : editable ? (
        <button
          type="button"
          onClick={browse}
          className={cn(
            "group flex w-full items-center gap-3 rounded-xl border border-dashed border-input bg-card/60 text-left transition-colors duration-150",
            "hover:border-primary/60 hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            compact ? "p-2.5" : "p-4",
            dragging && "border-primary bg-brand-subtle",
          )}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground group-hover:text-primary">
            <Upload className="size-4" aria-hidden />
          </span>
          <span className="grid gap-0.5">
            <span className="text-sm">
              <span className="font-medium text-primary">Choose a file</span> or drag it here
            </span>
            <span className="text-xs text-muted-foreground">{description ?? "PDF, PNG or JPEG, up to 5 MB"}</span>
          </span>
        </button>
      ) : (
        <p className="rounded-xl border border-dashed p-3.5 text-sm text-muted-foreground">Not uploaded</p>
      )}

      {rejected && document?.rejectionReason && (
        <p className="flex gap-2 text-sm text-warning-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Reviewer note:</span> {document.rejectionReason}
            {editable && (
              <>
                {" "}
                <button type="button" onClick={browse} className="font-medium underline underline-offset-4">
                  Upload a new file
                </button>
              </>
            )}
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function DocumentStatus({ status }: { status: KybDocument["status"] }) {
  if (status === "accepted") return <Badge variant="success">Accepted</Badge>
  if (status === "rejected") return <Badge variant="warning">Needs a new file</Badge>
  return <Badge variant="muted">Uploaded</Badge>
}
