"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import {
  Ban,
  Bot,
  CircleCheck,
  CirclePause,
  CirclePlay,
  ClipboardCheck,
  Flag,
  Landmark,
  MessageSquareText,
  MessageSquareWarning,
  RotateCcw,
  UserCog,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { loadTimeline } from "@/app/(console)/compliance/actions"
import { FormError } from "@/components/common/form-error"
import { useUrlState } from "@/components/common/url-state"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { AuditAction, AuditEntry } from "@/lib/api/types"
import { formatDateTime, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const ICONS: Partial<Record<AuditAction, LucideIcon>> = {
  "kyb.approved": ClipboardCheck,
  "kyb.changes_requested": MessageSquareWarning,
  "kyb.rejected": XCircle,
  "account.provision_retried": Landmark,
  "flag.raised": Flag,
  "flag.resolved": CircleCheck,
  "note.added": MessageSquareText,
  "business.suspended": CirclePause,
  "business.reinstated": CirclePlay,
  "business.banned": Ban,
  "business.unbanned": RotateCcw,
}

const TONE: Partial<Record<AuditAction, string>> = {
  "flag.raised": "bg-warning-subtle text-warning-foreground",
  "business.suspended": "bg-warning-subtle text-warning-foreground",
  "business.banned": "bg-destructive-subtle text-destructive",
  "kyb.rejected": "bg-destructive-subtle text-destructive",
  "flag.resolved": "bg-success-subtle text-success-foreground",
  "business.reinstated": "bg-success-subtle text-success-foreground",
  "business.unbanned": "bg-success-subtle text-success-foreground",
}

type Entry = AuditEntry<string | { _id: string; name: string | null } | null>

/** The staff note or reason an entry carries, if any (details differ by action). */
function quoteOf(entry: Entry) {
  const { note, reason } = entry.details
  if (typeof note === "string" && note && entry.action !== "note.added") return note
  if (entry.action === "kyb.rejected" && typeof reason === "string") return reason
  return null
}

/**
 * Audit entries as a vertical timeline. On the audit log `showBusiness` names the business, and the
 * staff name filters the log to that person (`?staff=`).
 */
export function AuditList({ entries, showBusiness = false }: { entries: Entry[]; showBusiness?: boolean }) {
  const { hrefWith } = useUrlState()
  return (
    <ol className="grid">
      {entries.map((e, i) => {
        const Icon = ICONS[e.action] ?? (e.action.startsWith("staff.") ? UserCog : MessageSquareText)
        const business = typeof e.business === "object" ? e.business : null
        const quote = quoteOf(e)
        const flagId = e.target?.kind === "flag" ? e.target._id : null
        return (
          <li key={e._id} className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 pb-6 last:pb-0">
            {i < entries.length - 1 && <span aria-hidden className="absolute top-9 bottom-1 left-4 w-px bg-border" />}
            <span className={cn("flex size-8 items-center justify-center rounded-[30%]", TONE[e.action] ?? "bg-brand-subtle text-primary")}>
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="grid min-w-0 gap-1 pt-1">
              <p className="text-sm text-pretty">
                {e.action === "note.added" ? <span className="whitespace-pre-line">{e.summary}</span> : e.summary}
                {flagId && (
                  <>
                    {" "}
                    <Link
                      href={business ? `/businesses/${business._id}/compliance?flag=${flagId}` : hrefWith({ flag: flagId })}
                      scroll={false}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      View flag
                    </Link>
                  </>
                )}
              </p>
              {quote && <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-line text-muted-foreground">{quote}</blockquote>}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {e.actor.type === "system" ? (
                  <span className="inline-flex items-center gap-1">
                    <Bot className="size-3" aria-hidden />
                    {e.actor.name}
                  </span>
                ) : showBusiness && e.actor._id ? (
                  <Link href={hrefWith({ staff: e.actor._id, before: undefined })} className="font-medium text-foreground hover:underline">
                    {e.actor.name}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">{e.actor.name}</span>
                )}
                {showBusiness && business && (
                  <>
                    <span aria-hidden>·</span>
                    <Link href={`/businesses/${business._id}/compliance`} className="hover:underline">
                      {business.name ?? "Business"}
                    </Link>
                  </>
                )}
                <span aria-hidden>·</span>
                <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                  {timeAgo(e.createdAt)}, {formatDateTime(e.createdAt)}
                </time>
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** A business's timeline: the 50 newest entries from the page, then older ones on demand. */
export function Timeline({ businessId, entries, nextBefore }: { businessId: string; entries: Entry[]; nextBefore: string | null }) {
  const [older, setOlder] = useState<{ items: Entry[]; next: string | null }>({ items: [], next: nextBefore })
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  // A refresh (after a new note, say) brings new entries; drop pages loaded against the old list.
  const [base, setBase] = useState(entries)
  if (base !== entries) {
    setBase(entries)
    setOlder({ items: [], next: nextBefore })
  }

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has happened yet. Staff actions and automatic flags show here.</p>
  }

  return (
    <div className="grid gap-5">
      <AuditList entries={[...entries, ...older.items]} />
      <FormError message={error} />
      {older.next && (
        <Button
          variant="outline"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await loadTimeline(businessId, older.next!)
              if (!result.ok) return setError(result.error)
              setError(undefined)
              setOlder((o) => ({ items: [...o.items, ...result.data.items], next: result.data.nextBefore }))
            })
          }
        >
          {pending && <Spinner />}
          Show older
        </Button>
      )}
    </div>
  )
}
