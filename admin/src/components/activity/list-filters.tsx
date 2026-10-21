"use client"

import { useState } from "react"
import { X } from "lucide-react"
import { useUrlState } from "@/components/common/url-state"
import { SearchBox } from "@/components/data-table/search-box"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect } from "@/components/ui/native-select"

export type SelectFilter = {
  key: string
  label: string
  /** Shown for "no filter", e.g. "Any status". */
  any: string
  options: { value: string; label: string }[]
}

type Props = {
  /** Prefix for element ids, so two filter bars can share a page. */
  id: string
  selects?: SelectFilter[]
  /** "Amount from" in whole naira (?min=). */
  amount?: boolean
  /** From and to dates (?from=&to=, Lagos days). */
  dates?: boolean
  search?: { label: string; placeholder: string }
  /** Keys every change clears, e.g. a cursor. Defaults to the page. */
  reset?: string[]
}

const FILTER_KEYS = ["min", "from", "to", "q"]

/** A row of filters above a list. Every change goes to the URL and back to page 1. */
export function ListFilters({ id, selects = [], amount, dates, search, reset = ["page"] }: Props) {
  const { searchParams, navigate } = useUrlState()
  const get = (key: string) => searchParams.get(key) ?? ""
  const cleared = Object.fromEntries(reset.map((k) => [k, undefined]))
  const set = (key: string, value: string | undefined) => navigate({ ...cleared, [key]: value })
  const keys = [...selects.map((s) => s.key), ...FILTER_KEYS]
  const active = keys.some((k) => searchParams.has(k))

  return (
    <div className="flex flex-wrap items-end gap-3 px-4 py-3 sm:px-6">
      {search && (
        <SearchBox
          id={`${id}-search`}
          label={search.label}
          placeholder={search.placeholder}
          value={get("q")}
          onSearch={(q) => set("q", q)}
          className="sm:w-72"
        />
      )}
      {selects.map((s) => (
        <div key={s.key} className="grid w-[calc(50%-0.375rem)] gap-1 sm:w-44">
          <label htmlFor={`${id}-${s.key}`} className="text-xs text-muted-foreground">
            {s.label}
          </label>
          <NativeSelect id={`${id}-${s.key}`} value={get(s.key)} onChange={(e) => set(s.key, e.target.value)}>
            <option value="">{s.any}</option>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      {amount && <AmountFilter id={`${id}-min`} value={get("min")} onChange={(v) => set("min", v)} />}
      {dates && (
        <>
          <div className="grid w-[calc(50%-0.375rem)] gap-1 sm:w-40">
            <label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">
              From
            </label>
            <Input id={`${id}-from`} type="date" value={get("from")} max={get("to") || undefined} onChange={(e) => set("from", e.target.value)} />
          </div>
          <div className="grid w-[calc(50%-0.375rem)] gap-1 sm:w-40">
            <label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
              To
            </label>
            <Input id={`${id}-to`} type="date" value={get("to")} min={get("from") || undefined} onChange={(e) => set("to", e.target.value)} />
          </div>
        </>
      )}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="mb-0.5"
          onClick={() => navigate({ ...cleared, ...Object.fromEntries(keys.map((k) => [k, undefined])) })}
        >
          <X data-icon="inline-start" aria-hidden />
          Clear filters
        </Button>
      )}
    </div>
  )
}

/** Whole naira; applied on Enter or when the field loses focus. */
function AmountFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string | undefined) => void }) {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  // Follow the URL when it changes from elsewhere ("Clear filters", back button).
  if (value !== seen) {
    setSeen(value)
    setText(value)
  }
  const commit = () => {
    const clean = text.replace(/[₦,\s]/g, "")
    const next = /^\d{1,12}$/.test(clean) && Number(clean) > 0 ? clean : ""
    setText(next ? Number(next).toLocaleString("en-NG") : "")
    if (next !== value.replace(/,/g, "")) onChange(next || undefined)
  }
  return (
    <div className="grid w-[calc(50%-0.375rem)] gap-1 sm:w-40">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Amount from
      </label>
      <InputGroup>
        <InputGroupAddon>₦</InputGroupAddon>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          placeholder="Any"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
        />
      </InputGroup>
    </div>
  )
}
