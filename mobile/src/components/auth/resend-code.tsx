import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { TextButton } from "@/components/ui/button";
import { ApiError, friendlyMessage } from "@/lib/api/errors";

const COOLDOWN = 60;

/** "Resend code" with the backend's 60-second cooldown, as on the web. Feedback stays inline. */
export function ResendCode({ onResend, startCoolingDown = true }: { onResend: () => Promise<unknown>; startCoolingDown?: boolean }) {
  const [secondsLeft, setSecondsLeft] = useState(startCoolingDown ? COOLDOWN : 0);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  async function resend() {
    setPending(true);
    setStatus(undefined);
    try {
      await onResend();
      setStatus({ tone: "ok", text: "We've sent a new code." });
      setSecondsLeft(COOLDOWN);
    } catch (err) {
      setStatus({ tone: "error", text: friendlyMessage(err) });
      if (err instanceof ApiError && err.code === "OTP_COOLDOWN") setSecondsLeft(COOLDOWN);
    } finally {
      setPending(false);
    }
  }

  const waiting = secondsLeft > 0;
  const label = pending
    ? "Sending…"
    : waiting
      ? `Resend in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
      : "Resend code";

  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center gap-x-1.5">
        <Text className="text-[14px] text-muted-foreground">Didn't get it?</Text>
        <TextButton onPress={resend} disabled={waiting || pending}>
          {label}
        </TextButton>
      </View>
      {status && (
        <Text
          accessibilityLiveRegion="polite"
          className={status.tone === "ok" ? "text-[13px] text-success-foreground" : "text-[13px] text-destructive-foreground"}
        >
          {status.text}
        </Text>
      )}
    </View>
  );
}
