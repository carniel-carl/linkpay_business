import * as Haptics from "expo-haptics";
import { useEffect, useState, type ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/cn";
import { PASSCODE_LENGTH } from "@/lib/security/passcode";
import { Keypad } from "./keypad";

export type EntryResult = "ok" | "error" | "keep";

const EASE_OUT = Easing.out(Easing.exp);

/**
 * The passcode screen on the navy band: the LinkPay lockup top left, a large title with four dots under
 * it, and a bare keypad at the bottom. `onComplete` runs when the last digit lands: "ok" pulses the dots,
 * "error" turns them red, shakes and clears them, "keep" clears without feedback (a step change). The
 * container supplies the navy and the top safe area; this pads the bottom itself.
 */
export function PasscodeEntry({
  title,
  subtitle,
  message,
  messageTone = "error",
  footer,
  biometric,
  onComplete,
}: {
  title: string;
  subtitle?: string;
  message?: string;
  messageTone?: "error" | "muted";
  footer?: ReactNode;
  biometric?: Parameters<typeof Keypad>[0]["biometric"];
  onComplete: (code: string) => Promise<EntryResult>;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 720;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
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
      setWrong(true);
      shake.set(
        withSequence(
          withTiming(-12, { duration: 50 }),
          withTiming(12, { duration: 60 }),
          withTiming(-8, { duration: 60 }),
          withTiming(8, { duration: 60 }),
          withTiming(0, { duration: 50 }),
        ),
      );
      setTimeout(() => {
        setCode("");
        setWrong(false);
      }, 360);
    } else if (result === "ok") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pulse.set(withSequence(withTiming(1.12, { duration: 110 }), withSpring(1)));
    } else {
      setCode("");
    }
  }

  return (
    <View className="flex-1 px-7">
      <Animated.View entering={FadeIn.duration(260)} className="pt-3">
        <Logo onBand size={compact ? 34 : 40} />
      </Animated.View>

      <Animated.View entering={FadeIn.duration(320)} className="flex-1 justify-center">
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.25}
          className="text-band-foreground"
          style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: compact ? 30 : 36, letterSpacing: -1.2, lineHeight: compact ? 32 : 38 }}
        >
          {title}
        </Text>
        {subtitle && (
          <Text maxFontSizeMultiplier={1.3} className="mt-2.5 max-w-[320px] text-[15px] leading-[22px] text-band-muted">
            {subtitle}
          </Text>
        )}
        <Animated.View
          style={dotsStyle}
          accessible
          accessibilityLabel={`${code.length} of ${PASSCODE_LENGTH} digits entered`}
          className={cn("flex-row gap-4 self-start", compact ? "mt-5" : "mt-7")}
        >
          {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
            <Dot key={i} filled={i < code.length} wrong={wrong} />
          ))}
        </Animated.View>
        <Text
          accessibilityLiveRegion="assertive"
          maxFontSizeMultiplier={1.3}
          className={cn(
            "min-h-11 max-w-[320px] pt-3 text-[14px] leading-5",
            messageTone === "error" ? "text-band-danger" : "text-band-muted",
          )}
        >
          {message ?? " "}
        </Text>
      </Animated.View>

      <Animated.View
        entering={FadeInDown.duration(420).easing(EASE_OUT)}
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <Keypad
          onDigit={add}
          onDelete={() => setCode((c) => c.slice(0, -1))}
          biometric={biometric}
          disabled={busy}
          keyHeight={compact ? 62 : 74}
        />
        <View className="min-h-11 items-center justify-center pt-1">{footer}</View>
      </Animated.View>
    </View>
  );
}

/** One passcode dot: an outline ring that pops to lime as its digit lands, red for a moment when wrong. */
function Dot({ filled, wrong }: { filled: boolean; wrong: boolean }) {
  const scale = useSharedValue(1);
  useEffect(() => {
    if (filled) scale.set(withSequence(withTiming(1.3, { duration: 90 }), withSpring(1, { damping: 12, stiffness: 280 })));
  }, [filled, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View
      style={style}
      className={cn("h-[18px] w-[18px] rounded-full", filled ? (wrong ? "bg-band-danger" : "bg-pop") : "border-2 border-band-muted/70")}
    />
  );
}
