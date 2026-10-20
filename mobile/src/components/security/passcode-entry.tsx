import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { cn } from "@/lib/cn";
import { PASSCODE_LENGTH } from "@/lib/security/passcode";
import { Keypad } from "./keypad";

export type EntryResult = "ok" | "error" | "keep";

/**
 * Title, four dots and the keypad on the navy band. `onComplete` runs when the last digit lands:
 * "ok" pulses the dots, "error" shakes and clears them, "keep" clears without feedback (a step change).
 */
export function PasscodeEntry({
  title,
  subtitle,
  message,
  messageTone = "error",
  header,
  footer,
  biometric,
  onComplete,
}: {
  title: string;
  subtitle?: string;
  message?: string;
  messageTone?: "error" | "muted";
  header?: ReactNode;
  footer?: ReactNode;
  biometric?: Parameters<typeof Keypad>[0]["biometric"];
  onComplete: (code: string) => Promise<EntryResult>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const shake = useSharedValue(0);
  const pulse = useSharedValue(1);

  const dotsStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }, { scale: pulse.get() }] }));

  async function add(d: string) {
    if (busy || code.length >= PASSCODE_LENGTH) return;
    const next = code + d;
    setCode(next);
    if (next.length < PASSCODE_LENGTH) return;
    setBusy(true);
    const result = await onComplete(next);
    setBusy(false);
    if (result === "error") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake.set(
        withSequence(
        withTiming(-12, { duration: 50 }),
        withTiming(12, { duration: 60 }),
        withTiming(-8, { duration: 60 }),
        withTiming(8, { duration: 60 }),
        withTiming(0, { duration: 50 }),
        ),
      );
      setTimeout(() => setCode(""), 260);
    } else if (result === "ok") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pulse.set(withSequence(withTiming(1.12, { duration: 110 }), withSpring(1)));
    } else {
      setCode("");
    }
  }

  return (
    <View className="flex-1 justify-between">
      <View className="items-center gap-3 px-8">
        {header}
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.25}
          className="text-center text-band-foreground"
          style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: 24, letterSpacing: -0.84, lineHeight: 27 }}
        >
          {title}
        </Text>
        {subtitle && <Text className="text-center text-[15px] leading-[22px] text-band-muted">{subtitle}</Text>}
        <Animated.View
          style={dotsStyle}
          accessible
          accessibilityLabel={`${code.length} of ${PASSCODE_LENGTH} digits entered`}
          className="mt-6 flex-row gap-4"
        >
          {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
            <View
              key={i}
              className={cn(
                "h-3.5 w-3.5 rounded-full",
                i < code.length ? "bg-pop" : "border-[1.5px] border-band-muted/70",
              )}
            />
          ))}
        </Animated.View>
        <Text
          accessibilityLiveRegion="assertive"
          className={cn("min-h-11 pt-3 text-center text-[15px] leading-5", messageTone === "error" ? "text-band-danger" : "text-band-muted")}
        >
          {message ?? " "}
        </Text>
      </View>
      <View className="gap-4">
        <Keypad onDigit={add} onDelete={() => setCode((c) => c.slice(0, -1))} biometric={biometric} disabled={busy} />
        <View className="min-h-11 items-center justify-center">{footer}</View>
      </View>
    </View>
  );
}
