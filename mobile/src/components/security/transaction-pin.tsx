import { StatusBar } from "expo-status-bar";
import { useState, type ReactNode } from "react";
import { Modal, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { isWeakPin, WEAK_PIN } from "@/lib/api/transaction-pin";
import { useAuth } from "@/lib/auth/store";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

// Building blocks for the transaction PIN: the navy modal its keypad sits in, choosing a new PIN, and a
// message screen for a locked PIN or a missing password. Used by the confirmation sheet and More, Transaction PIN.

/**
 * A native full-screen modal on the navy band, like the passcode confirmation, so it covers the header and tab
 * bar. It hides while the app is locked, so the lock screen is never under it; what it holds comes back after.
 */
export function PinModal({ children, onRequestClose }: { children: ReactNode; onRequestClose: () => void }) {
  const locked = useAuth((s) => s.status === "locked");
  return (
    <Modal visible={!locked} animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent navigationBarTranslucent>
      <View className="flex-1 bg-band">
        <StatusBar style="light" />
        <SafeAreaView edges={["top"]} style={{ flex: 1, paddingTop: 16 }}>
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/**
 * What saving a chosen PIN came to: "ok" (pulse), "error" (shake: it failed and the caller moved on), "keep"
 * (no feedback: the caller has closed it), or choose again with a message.
 */
export type ChosenResult = EntryResult | { again: string };

/**
 * Choose a new 4-digit PIN, then enter it again. Weak PINs (the server's rule) are refused before the confirm
 * step. `onChosen` saves it; while it runs, `pending` shows under the dots. The PIN is the same length as the
 * passcode, so the passcode keypad and dots serve both.
 */
export function ChoosePin({
  title,
  subtitle,
  pending,
  onChosen,
  footer,
}: {
  title: string;
  subtitle: string;
  pending?: string;
  onChosen: (pin: string) => Promise<ChosenResult>;
  footer?: ReactNode;
}) {
  const [first, setFirst] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function complete(pin: string): Promise<EntryResult> {
    if (!first) {
      if (isWeakPin(pin)) {
        setMessage(WEAK_PIN);
        return "error";
      }
      setFirst(pin);
      setMessage(undefined);
      return "keep";
    }
    if (pin !== first) {
      setFirst(undefined);
      setMessage("Those PINs don't match. Start again.");
      return "error";
    }
    setMessage(undefined);
    const result = await onChosen(pin);
    setFirst(undefined);
    if (typeof result === "object") {
      setMessage(result.again);
      return "error";
    }
    return result;
  }

  return (
    <PasscodeEntry
      title={first ? "Enter it again" : title}
      subtitle={first ? "Confirm your new transaction PIN." : subtitle}
      message={pending ?? message}
      messageTone={pending ? "muted" : "error"}
      onComplete={complete}
      footer={footer}
    />
  );
}

/** A full-band message with one main action and a way out: a locked PIN, or an account without a password. */
export function PinNotice({
  title,
  body,
  action,
  onAction,
  onCancel,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 px-7" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
      <Animated.View entering={FadeIn.duration(260)} className="pt-3">
        <Logo onBand size={40} />
      </Animated.View>
      <Animated.View entering={FadeIn.duration(320)} className="flex-1 justify-center">
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.25}
          className="text-band-foreground"
          style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: 36, letterSpacing: -1.2, lineHeight: 38 }}
        >
          {title}
        </Text>
        <Text accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3} className="mt-2.5 max-w-[320px] text-[15px] leading-[22px] text-band-muted">
          {body}
        </Text>
      </Animated.View>
      <View className="gap-3">
        <Button variant="pop" onPress={onAction} className="h-14">
          {action}
        </Button>
        <Button variant="band" onPress={onCancel} className="h-14">
          Cancel
        </Button>
      </View>
    </View>
  );
}
