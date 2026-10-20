"use client"

import { REGEXP_ONLY_DIGITS } from "input-otp"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"

type Props = {
  id?: string
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
}

/** Six-digit code entry. Pastes and SMS/email autofill work (one-time-code). */
export function CodeInput({ id, value, onChange, onComplete, disabled, invalid, autoFocus = true }: Props) {
  const slot = "size-11 font-mono text-lg sm:size-12"
  return (
    <InputOTP
      id={id}
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-invalid={invalid || undefined}
    >
      <InputOTPGroup>
        {[0, 1, 2].map((i) => (
          <InputOTPSlot key={i} index={i} className={slot} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator className="text-muted-foreground" />
      <InputOTPGroup>
        {[3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} className={slot} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
