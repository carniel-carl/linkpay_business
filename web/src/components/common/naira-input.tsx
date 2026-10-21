"use client"

import type { ComponentProps } from "react"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { formatNairaInput } from "@/lib/transfers"
import { cn } from "@/lib/utils"

/** Digits and the point: the characters formatting never adds or removes on its own. */
const kept = (s: string) => s.replace(/[^\d.]/g, "").length

/** The first position in `text` with `count` kept characters after it, so the caret sits just after the last one typed. */
function caretFromEnd(text: string, count: number) {
  let after = 0
  let i = text.length
  while (i > 0 && after < count) if (/[\d.]/.test(text[--i])) after++
  while (i > 0 && text[i - 1] === ",") i--
  return i
}

/**
 * A ₦ amount field that groups thousands as you type ("2000000" shows as "2,000,000").
 * `value` and `onChange` carry the formatted text; read it with parseNairaToKobo, which ignores commas.
 */
export function NairaInput({
  value,
  invalid,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange"> & {
  value: string
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>₦</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        {...props}
        className={cn("figure", className)}
        value={formatNairaInput(value)}
        aria-invalid={invalid}
        onKeyDown={(e) => {
          props.onKeyDown?.(e)
          // Deleting next to a comma deletes the digit beyond it, not the comma.
          const el = e.currentTarget
          const at = el.selectionStart
          if (at === null || at !== el.selectionEnd) return
          if (e.key === "Backspace" && el.value[at - 1] === ",") el.setSelectionRange(at - 1, at - 1)
          if (e.key === "Delete" && el.value[at] === ",") el.setSelectionRange(at + 1, at + 1)
        }}
        onChange={(e) => {
          // Write the formatted text and caret straight to the field, so React finds nothing to change and the caret stays put.
          const el = e.target
          const next = formatNairaInput(el.value)
          const after = kept(el.value.slice(el.selectionStart ?? el.value.length))
          el.value = next
          const caret = caretFromEnd(next, after)
          el.setSelectionRange(caret, caret)
          onChange(next)
        }}
      />
    </InputGroup>
  )
}
