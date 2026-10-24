"use client"

import { useEffect, useRef, useState } from "react"
import { BookUser, Check, Search } from "lucide-react"
import { searchBeneficiaries } from "@/app/(dashboard)/beneficiaries/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import type { Beneficiary } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { BeneficiaryName } from "./parts"

const PAGE = 50

/** Where the picker is used: a payout list, a bulk transfer (several at once) or Send money (one). */
type Purpose = "list" | "bulk" | "send"

const COPY: Record<Purpose, { title: string; description: string; empty: string; added: string; full: string; none: string }> = {
  list: {
    title: "Add from beneficiaries",
    description: "Tick everyone this list pays. You set each amount after adding them.",
    empty: "Close this and use “Add a new account”. Each account you add is saved as a beneficiary.",
    added: "In the list",
    full: "That fills the list. A list can pay up to 200 people.",
    none: "This list already pays 200 people, the most one list can.",
  },
  bulk: {
    title: "Add from beneficiaries",
    description: "Tick everyone to pay. You set each amount after adding them.",
    empty: "Save the people you pay often on the Beneficiaries page, or tick “Save new accounts to beneficiaries” when you send this.",
    added: "Added",
    full: "That makes 200 people, the most one bulk transfer can pay.",
    none: "This transfer already pays 200 people, the most one bulk transfer can.",
  },
  send: {
    title: "Choose a beneficiary",
    description: "Someone your team has saved. Their name was checked with the bank when they were saved.",
    empty: "Save the people you pay often on the Beneficiaries page, or tick “Save to beneficiaries” when you send to a new account.",
    added: "",
    full: "",
    none: "",
  },
}

type Props = {
  children: React.ReactNode
} & (
  | {
      /** Several at once (a payout list or a bulk transfer). */
      purpose?: "list" | "bulk"
      /** Beneficiaries already added. */
      added: Set<string>
      /** How many more rows there's room for. */
      room: number
      onAdd: (picked: Beneficiary[]) => void
    }
  | {
      /** One, for Send money: picking closes the dialog. */
      purpose: "send"
      /** The one chosen now, ticked in the list. */
      selected?: string
      onPick: (beneficiary: Beneficiary) => void
    }
)

/**
 * Pick saved beneficiaries (search by name, nickname, account number or bank). For a list or a bulk transfer,
 * several at once: those already added are shown ticked and can't be picked twice, up to `room`. For Send money,
 * one: choosing it closes the dialog.
 */
export function BeneficiaryPickerDialog(props: Props) {
  const { children } = props
  const copy = COPY[props.purpose ?? "list"]
  const single = props.purpose === "send"
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [results, setResults] = useState<{ query: string; items: Beneficiary[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [picked, setPicked] = useState<Map<string, Beneficiary>>(new Map())
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Bumped so an older search's answer never replaces a newer one.
  const seq = useRef(0)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function load(text: string, skip = 0) {
    const run = ++seq.current
    setLoading(true)
    setError(undefined)
    const result = await searchBeneficiaries({ q: text || undefined, skip, take: PAGE })
    if (run !== seq.current) return
    setLoading(false)
    if (!result.ok) return setError(result.error)
    setResults((prev) => ({
      query: text,
      items: skip > 0 && prev?.query === text ? [...prev.items, ...result.data.items] : result.data.items,
      total: result.data.total,
    }))
  }

  /** Searches after a short pause in typing. */
  function type(text: string) {
    setQ(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(text.trim()), 300)
  }

  function toggle(b: Beneficiary) {
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(b._id)) next.delete(b._id)
      else next.set(b._id, b)
      return next
    })
  }

  function reset() {
    clearTimeout(timer.current)
    seq.current++
    setQ("")
    setResults(null)
    setLoading(false)
    setError(undefined)
    setPicked(new Map())
  }

  function close() {
    setOpen(false)
    reset()
  }

  const room = props.purpose === "send" ? Infinity : props.room
  const full = picked.size >= room
  const items = results?.items ?? []
  const nothingSaved = results && !results.query && results.total === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load("")
        else reset()
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search beneficiaries"
            placeholder="Search by name, nickname, account or bank"
            value={q}
            onChange={(e) => type(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              clearTimeout(timer.current)
              void load(q.trim())
            }}
          />
          {loading && (
            <InputGroupAddon align="inline-end">
              <Spinner />
            </InputGroupAddon>
          )}
        </InputGroup>

        <FormError message={error} />

        <div className="-mx-6 min-h-48 overflow-y-auto border-y" aria-busy={loading}>
          {!results ? (
            <p role="status" className="flex items-center gap-2 px-6 py-6 text-sm text-muted-foreground">
              <Spinner /> Loading beneficiaries
            </p>
          ) : nothingSaved ? (
            <Empty className="border-0 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
                  <BookUser aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No beneficiaries yet</EmptyTitle>
                <EmptyDescription>{copy.empty}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : items.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">No beneficiaries match &ldquo;{results.query}&rdquo;.</p>
          ) : props.purpose === "send" ? (
            <ul className="divide-y">
              {items.map((b) => {
                const chosen = props.selected === b._id
                return (
                  <li key={b._id}>
                    <button
                      type="button"
                      aria-current={chosen || undefined}
                      onClick={() => {
                        props.onPick(b)
                        close()
                      }}
                      className="flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                    >
                      <BeneficiaryName beneficiary={b} className="flex-1" />
                      {b.onLinkPay && <span className="shrink-0 rounded-md bg-brand-subtle px-1.5 py-0.5 text-[11px] font-medium text-primary">On LinkPay</span>}
                      {chosen && <Check className="size-4 shrink-0" aria-label="Chosen" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <ul className="divide-y">
              {items.map((b) => {
                const inList = props.added.has(b._id)
                const checked = inList || picked.has(b._id)
                const disabled = inList || (full && !picked.has(b._id))
                return (
                  <li key={b._id}>
                    <label
                      className={cn(
                        "flex items-center gap-3 px-6 py-3 transition-colors",
                        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/50",
                      )}
                    >
                      <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => toggle(b)} aria-label={b.accountName} />
                      <BeneficiaryName beneficiary={b} className="flex-1" />
                      {inList && <span className="shrink-0 text-xs text-muted-foreground">{copy.added}</span>}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {results && results.items.length < results.total && (
            <div className="border-t px-6 py-3">
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => load(results.query, results.items.length)}>
                {loading && <Spinner />}
                Show more ({results.total - results.items.length} left)
              </Button>
            </div>
          )}
        </div>

        {!single && full && room > 0 && <p className="text-sm text-muted-foreground">{copy.full}</p>}
        {!single && room <= 0 && <p className="text-sm text-destructive">{copy.none}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {props.purpose !== "send" && (
            <Button
              disabled={picked.size === 0}
              onClick={() => {
                props.onAdd([...picked.values()])
                close()
              }}
            >
              {picked.size === 0 ? "Add" : `Add ${picked.size}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
