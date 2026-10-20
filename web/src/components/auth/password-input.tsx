"use client"

import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

export function PasswordInput(props: React.ComponentProps<typeof InputGroupInput>) {
  const [visible, setVisible] = useState(false)
  return (
    <InputGroup className="h-9">
      <InputGroupInput type={visible ? "text" : "password"} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
