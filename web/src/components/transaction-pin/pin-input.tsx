"use client"

import { useContext } from "react"
import { OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp"
import { InputOTP, InputOTPGroup } from "@/components/ui/input-otp"
import { PIN_LENGTH } from "@/lib/transaction-pin"
import { cn } from "@/lib/utils"

type Props = {
  id?: string
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  ref?: React.Ref<HTMLInputElement>
  "aria-label"?: string
}

/**
 * The 4-digit transaction PIN, masked: each slot shows a dot, never the digit. Built like CodeInput on
 * input-otp, but without one-time-code autofill, and kept out of password managers so it's never saved.
 */
export function PinInput({ id, value, onChange, onComplete, disabled, invalid, autoFocus, ref, ...aria }: Props) {
  return (
    <InputOTP
      id={id}
      ref={ref}
      maxLength={PIN_LENGTH}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="off"
      pushPasswordManagerStrategy="none"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-form-type="other"
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-invalid={invalid || undefined}
      {...aria}
    >
      <InputOTPGroup>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <MaskedSlot key={i} index={i} invalid={invalid} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}

/** InputOTPSlot's look, with a dot in place of the digit. */
function MaskedSlot({ index, invalid }: { index: number; invalid?: boolean }) {
  const slot = useContext(OTPInputContext)?.slots[index]
  return (
    <div
      data-slot="input-otp-slot"
      data-active={slot?.isActive}
      aria-invalid={invalid || undefined}
      className={cn(
        "relative flex size-12 items-center justify-center border-y border-r border-input transition-all outline-none first:rounded-l-lg first:border-l last:rounded-r-lg",
        "aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-3 data-[active=true]:ring-ring/50",
        "data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/20 dark:bg-input/30 dark:data-[active=true]:aria-invalid:ring-destructive/40",
      )}
    >
      {slot?.char && <span className="size-2.5 rounded-full bg-foreground" aria-hidden />}
      {slot?.hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-caret-blink bg-foreground duration-1000" />
        </div>
      )}
    </div>
  )
}
