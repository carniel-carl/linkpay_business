"use client"

import Link from "next/link"
import { Bot, CircleCheck, ShieldCheck } from "lucide-react"
import { useUrlState } from "@/components/common/url-state"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Flag } from "@/lib/api/types"
import { OUTCOME_LABELS } from "@/lib/compliance"
import { formatDate, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { RestrictionBadge, SeverityBadge } from "./badges"

const head = "h-10 text-xs font-medium text-muted-foreground"
const edge = "first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6"

/** Flags as rows; each opens the flag sheet (`?flag=`). `showBusiness` for the platform queue. */
export function FlagsList({
  flags,
  caption,
  showBusiness = true,
  empty,
  busy,
}: {
  flags: Flag[]
  caption: string
  showBusiness?: boolean
  empty: { title: string; description: string }
  busy?: boolean
}) {
  const { hrefWith } = useUrlState()

  if (flags.length === 0) {
    return (
      <Empty className="min-h-64 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheck aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{empty.title}</EmptyTitle>
          <EmptyDescription>{empty.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Table aria-busy={busy} className="min-w-180">
      <caption className="sr-only">{caption}</caption>
      <TableHeader className="bg-muted/60">
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={cn(head, edge, "w-28")}>Severity</TableHead>
          <TableHead scope="col" className={head}>Concern</TableHead>
          <TableHead scope="col" className={head}>Raised by</TableHead>
          <TableHead scope="col" className={cn(head, edge)}>Raised</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={cn("transition-opacity duration-150", busy && "opacity-60")}>
        {flags.map((f) => (
          <TableRow key={f._id} className="relative has-[a:focus-visible]:bg-muted/60">
            <TableCell className={cn(edge, "py-3 align-top")}>
              <SeverityBadge severity={f.severity} />
            </TableCell>
            <TableCell className="py-3 align-top">
              <div className="grid min-w-64 gap-1">
                {showBusiness && (
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{f.business.name ?? "Unknown business"}</span>
                    <RestrictionBadge status={f.business.compliance} />
                  </span>
                )}
                <Link
                  href={hrefWith({ flag: f._id })}
                  scroll={false}
                  className="w-fit text-pretty outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
                >
                  {f.summary}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {f.categoryLabel}
                  {f.status === "resolved" && f.resolution && (
                    <span className="ml-2 inline-flex items-center gap-1 text-success-foreground">
                      <CircleCheck className="size-3" aria-hidden />
                      {f.resolution.outcome ? OUTCOME_LABELS[f.resolution.outcome] : "Resolved"}
                      {f.resolution.by && ` by ${f.resolution.by.name}`}
                    </span>
                  )}
                </span>
              </div>
            </TableCell>
            <TableCell className="py-3 align-top">
              {f.source === "rule" ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Bot className="size-3.5 text-muted-foreground" aria-hidden />
                  Automatic
                </span>
              ) : (
                <span className="whitespace-nowrap">{f.raisedBy?.name ?? "Staff"}</span>
              )}
            </TableCell>
            <TableCell className={cn(edge, "py-3 align-top")}>
              <div className="grid gap-0.5 whitespace-nowrap">
                <span>{timeAgo(f.createdAt)}</span>
                <span className="text-xs text-muted-foreground figure">{formatDate(f.createdAt)}</span>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
