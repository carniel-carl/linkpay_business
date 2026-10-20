import type { OTPInputRef } from "input-otp-native";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CodeField } from "@/components/ui/code-field";
import { FormError } from "@/components/ui/form-error";
import { friendlyMessage } from "@/lib/api/errors";

/**
 * A 6-digit code form. Submits by itself when the last digit lands; on failure the error shows
 * above and the slots clear for another try. `onSubmit` may return a message to show instead.
 */
export function CodeForm({
  label,
  submitLabel,
  onSubmit,
  children,
}: {
  label: string;
  submitLabel: string;
  onSubmit: (code: string) => Promise<string | void>;
  children?: ReactNode;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const input = useRef<OTPInputRef>(null);

  async function submit(value = code) {
    if (pending) return;
    if (value.length !== 6) return setError("Enter the 6-digit code.");
    setError(undefined);
    setPending(true);
    try {
      const message = await onSubmit(value);
      if (message) {
        setError(message);
        setCode("");
        input.current?.clear();
      }
    } catch (err) {
      setError(friendlyMessage(err));
      setCode("");
      input.current?.clear();
      input.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <FormError message={error} />
      <CodeField ref={input} label={label} value={code} onChange={setCode} onComplete={submit} invalid={!!error} disabled={pending} />
      <Button loading={pending} disabled={code.length !== 6} onPress={() => submit()}>
        {submitLabel}
      </Button>
      {children}
    </>
  );
}
