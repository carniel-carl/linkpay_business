import { useState, type ReactNode } from "react";
import { isTooSimple } from "@/lib/security/passcode";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

/** Choose, then confirm, a 4-digit passcode. Simple patterns are refused before the confirm step. */
export function CreatePasscode({
  title = "Create a passcode",
  subtitle = "You'll use it to open LinkPay Business on this phone.",
  onCreated,
  footer,
}: {
  title?: string;
  subtitle?: string;
  onCreated: (code: string) => Promise<void>;
  footer?: ReactNode;
}) {
  const [first, setFirst] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function complete(code: string): Promise<EntryResult> {
    if (!first) {
      if (isTooSimple(code)) {
        setMessage("That's easy to guess. Avoid repeated digits and runs like 1234.");
        return "error";
      }
      setFirst(code);
      setMessage(undefined);
      return "keep";
    }
    if (code !== first) {
      setFirst(undefined);
      setMessage("Those passcodes don't match. Start again.");
      return "error";
    }
    await onCreated(code);
    return "ok";
  }

  return (
    <PasscodeEntry
      title={first ? "Enter it again" : title}
      subtitle={first ? "Confirm your new passcode." : subtitle}
      message={message}
      onComplete={complete}
      footer={footer}
    />
  );
}
