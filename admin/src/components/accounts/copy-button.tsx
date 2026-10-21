"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Copies `value` and confirms with a toast. Icon-only unless `children` are given. */
export function CopyButton({
  value,
  message,
  label,
  children,
  variant = "ghost",
  size,
  className,
}: {
  value: string
  message: string
  label: string
  children?: React.ReactNode
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (await writeClipboard(value)) {
      toast.success(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      toast.error("Couldn't copy. Select the text and copy it instead.")
    }
  }

  const Icon = copied ? Check : Copy
  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (children ? "sm" : "icon-sm")}
      onClick={copy}
      aria-label={children ? undefined : label}
      className={cn(copied && "text-success", className)}
    >
      <Icon data-icon={children ? "inline-start" : undefined} aria-hidden />
      {children}
    </Button>
  )
}

export function shareText(account: { bankName?: string; accountName?: string; accountNumber: string }) {
  return [
    `Bank: ${account.bankName ?? "LinkPay partner bank"}`,
    `Account name: ${account.accountName ?? ""}`.trim(),
    `Account number: ${account.accountNumber}`,
  ].join("\n")
}
