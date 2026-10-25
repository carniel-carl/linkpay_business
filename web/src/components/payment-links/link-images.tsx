"use client"

import { useEffect, useRef, useState } from "react"
import { ImagePlus, RotateCw, Star, X } from "lucide-react"
import { uploadPaymentLinkImage } from "@/app/(dashboard)/payment-links/actions"
import { useReadOnly, WriteGate } from "@/components/shell/write-gate"
import { Spinner } from "@/components/ui/spinner"
import type { PaymentLinkImage } from "@/lib/api/types"
import { IMAGE_TYPES, LIMITS, linkImageSrc } from "@/lib/payment-links"
import { cn } from "@/lib/utils"

/** One picture in the form: saved, uploading, or failed (kept so it can be retried). */
export type Picture = {
  key: string
  /** The upload's id once the backend has it. */
  id?: string
  /** What the browser shows: a local preview while uploading, then the proxied file. */
  src: string
  state: "uploading" | "ready" | "failed"
  error?: string
  file?: File
  /** Pixel size, for the preview's gallery. Known once the local file has loaded, or from the upload. */
  width?: number
  height?: number
}

let seq = 0
const newKey = () => `img${++seq}`

export const picturesFrom = (images: PaymentLinkImage[] | undefined): Picture[] =>
  (images ?? []).map((img) => ({ key: newKey(), id: img._id, src: linkImageSrc(img), state: "ready", width: img.width, height: img.height }))

const MAX_EDGE = 2400

/**
 * Gets a file the backend accepts: PNG, JPEG or WebP under 5 MB. Anything else the browser can open
 * (HEIC on Safari, a huge PNG) is redrawn as a JPEG at most 2400px on its longest side.
 */
async function prepare(file: File): Promise<File> {
  if (IMAGE_TYPES.includes(file.type) && file.size <= LIMITS.maxImageBytes) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("We can't open that file. Use a PNG, JPG or WebP picture.")
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  for (const quality of [0.88, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality))
    if (blob && blob.size <= LIMITS.maxImageBytes) return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" })
  }
  throw new Error("That picture is too large, even after shrinking it. Use a smaller one.")
}

const uploadError = (code?: string, error?: string) =>
  code === "UNSUPPORTED_FILE_TYPE" ? "Use a PNG, JPG or WebP picture." : (error ?? "We couldn't upload that picture. Try again.")

/**
 * Up to 4 pictures for the link's page. Each uploads as soon as it's chosen; the first is the cover.
 * The form sends the ids in order when it's saved.
 */
export function LinkImages({ value, onChange, error }: { value: Picture[]; onChange: (update: (prev: Picture[]) => Picture[]) => void; error?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const left = LIMITS.maxImages - value.length
  // A dropped file uploads straight away too, so dropping is off while the business is suspended, like the add buttons.
  const { readOnly } = useReadOnly()

  // Local previews are blob: URLs; let them go when the form goes away.
  const blobs = useRef(new Set<string>())
  useEffect(() => {
    const set = blobs.current
    return () => set.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const patch = (key: string, next: Partial<Picture>) => onChange((prev) => prev.map((p) => (p.key === key ? { ...p, ...next } : p)))

  async function upload(key: string, original: File) {
    patch(key, { state: "uploading", error: undefined })
    try {
      const file = await prepare(original)
      const form = new FormData()
      form.set("file", file)
      const result = await uploadPaymentLinkImage(form)
      if (!result.ok) return patch(key, { state: "failed", error: uploadError(result.code, result.error), file: original })
      patch(key, { state: "ready", id: result.data._id, file: undefined, width: result.data.width, height: result.data.height })
    } catch (err) {
      patch(key, { state: "failed", error: err instanceof Error ? err.message : "We couldn't upload that picture.", file: original })
    }
  }

  function add(files: FileList | File[] | null) {
    setNotice(undefined)
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name))
    if (!list.length) return setNotice("Choose a picture: PNG, JPG or WebP.")
    if (list.length > left) setNotice(`Only ${LIMITS.maxImages} pictures fit, so we added the first ${left}.`)
    const added = list.slice(0, left).map((file) => {
      const src = URL.createObjectURL(file)
      blobs.current.add(src)
      return { key: newKey(), src, state: "uploading" as const, file }
    })
    onChange((prev) => [...prev, ...added])
    added.forEach((p) => {
      const img = new Image()
      img.onload = () => patch(p.key, { width: img.naturalWidth, height: img.naturalHeight })
      img.src = p.src
      upload(p.key, p.file)
    })
  }

  const remove = (key: string) => onChange((prev) => prev.filter((p) => p.key !== key))
  const makeCover = (key: string) => onChange((prev) => [...prev.filter((p) => p.key === key), ...prev.filter((p) => p.key !== key)])

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (readOnly || left <= 0 || !e.dataTransfer.types.includes("Files")) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (!readOnly && left > 0) add(e.dataTransfer.files)
    },
  }

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
      multiple
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        add(e.target.files)
        e.target.value = ""
      }}
    />
  )

  if (value.length === 0) {
    return (
      <div className="grid gap-2">
        {picker}
        {/* Each picture uploads as soon as it's added, so adding is gated while the business is suspended. */}
        <WriteGate block>
        <button
          type="button"
          onClick={() => input.current?.click()}
          {...dropProps}
          className={cn(
            "grid min-h-40 place-items-center gap-2 rounded-[14px] border border-dashed bg-muted/40 px-6 py-8 text-center transition-colors duration-150 outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50",
            dragging && "border-primary bg-muted/80",
            error && "border-destructive",
          )}
        >
          <span className="grid gap-2 justify-items-center">
            <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">Add pictures</span>
            <span className="max-w-72 text-xs text-muted-foreground">
              A product photo, a book cover or a flyer, so customers know what they&apos;re paying for. Up to 4, PNG, JPG or WebP.
            </span>
          </span>
        </button>
        </WriteGate>
        {(notice || error) && <p className="text-sm text-destructive">{error ?? notice}</p>}
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      {picker}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" {...dropProps}>
        {value.map((p, i) => (
          <li key={p.key} className="grid gap-1.5">
            <div
              className={cn(
                "group relative aspect-square overflow-hidden rounded-[14px] bg-muted",
                p.state === "failed" && "ring-2 ring-destructive",
                i === 0 && p.state !== "failed" && "ring-2 ring-primary",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview or a proxied upload */}
              <img src={p.src} alt={`Picture ${i + 1}${i === 0 ? ", the cover" : ""}`} className={cn("size-full object-cover", p.state !== "ready" && "opacity-50")} />
              {p.state === "uploading" && (
                <span className="absolute inset-0 grid place-items-center" role="status">
                  <Spinner />
                  <span className="sr-only">Uploading picture {i + 1}</span>
                </span>
              )}
              {i === 0 && <span className="absolute bottom-2 left-2 rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">Cover</span>}
              <div className="absolute top-1.5 right-1.5 flex gap-1">
                {i > 0 && p.state === "ready" && (
                  <IconAction label={`Make picture ${i + 1} the cover`} onClick={() => makeCover(p.key)}>
                    <Star aria-hidden />
                  </IconAction>
                )}
                {p.state === "failed" && p.file && (
                  <IconAction label={`Try picture ${i + 1} again`} onClick={() => upload(p.key, p.file!)}>
                    <RotateCw aria-hidden />
                  </IconAction>
                )}
                <IconAction label={`Remove picture ${i + 1}`} onClick={() => remove(p.key)}>
                  <X aria-hidden />
                </IconAction>
              </div>
            </div>
            {p.state === "failed" && <p className="text-xs text-destructive">{p.error}</p>}
          </li>
        ))}
        {left > 0 && (
          <li>
            <WriteGate block>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className={cn(
                "grid aspect-square w-full place-items-center rounded-[14px] border border-dashed bg-muted/40 text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                dragging && "border-primary bg-muted/80",
              )}
            >
              <span className="grid justify-items-center gap-1 text-xs">
                <ImagePlus className="size-5" aria-hidden />
                Add ({left} left)
              </span>
            </button>
            </WriteGate>
          </li>
        )}
      </ul>
      {(notice || error) && <p className="text-sm text-destructive">{error ?? notice}</p>}
      {value.length > 1 && !error && !notice && <p className="text-xs text-muted-foreground">The cover shows first. Use the star to make another picture the cover.</p>}
    </div>
  )
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors outline-none hover:bg-black/75 focus-visible:ring-3 focus-visible:ring-white/70 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}
