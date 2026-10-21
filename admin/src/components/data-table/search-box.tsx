"use client"

import { useEffect, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

/** Searches as you type (after a short pause) or on Enter. */
export function SearchBox({
  id,
  label,
  placeholder,
  value,
  onSearch,
  className,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  onSearch: (q: string | undefined) => void
  className?: string
}) {
  const [text, setText] = useState(value)
  // The last URL value seen, and the last search this box asked for.
  const [seen, setSeen] = useState(value)
  const [sent, setSent] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Follow the URL when it changes from elsewhere (back button, "Clear search and filters"),
  // but not when it catches up with what's being typed.
  if (value !== seen) {
    setSeen(value)
    if (value !== sent) {
      setSent(value)
      setText(value)
    }
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  function send(raw: string) {
    clearTimeout(timer.current)
    const q = raw.trim()
    if (q === sent) return
    setSent(q)
    onSearch(q || undefined)
  }

  return (
    <form
      role="search"
      className={cn("w-full sm:w-80", className)}
      onSubmit={(e) => {
        e.preventDefault()
        send(text)
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <InputGroup>
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          id={id}
          type="search"
          className="[&::-webkit-search-cancel-button]:appearance-none"
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => send(next), 350)
          }}
          autoComplete="off"
        />
        {text && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => {
                setText("")
                send("")
              }}
            >
              <X aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  )
}
