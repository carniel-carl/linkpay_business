import { useEffect } from "react";
import { Platform, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { useRecoveryCodesOnScreen } from "@/lib/recovery-codes";
import { useSensitiveCopy } from "@/lib/security/sensitive-copy";
import { useTheme } from "@/theme/theme";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * The recovery codes, shown once: a monospace grid, Copy all (taken off the clipboard after a minute) and
 * "I've saved them". They live only in the state of the screen that got them, never in storage. While they're up,
 * tapping More again doesn't pop them away (useRecoveryCodesOnScreen).
 */
export function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { shadows } = useTheme();
  const clipboard = useSensitiveCopy();

  useEffect(() => {
    useRecoveryCodesOnScreen.setState({ shown: true });
    return () => useRecoveryCodesOnScreen.setState({ shown: false });
  }, []);

  return (
    <View className="gap-4">
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">
        If you can&apos;t use your authenticator app, for example after losing your phone, sign in with one of these
        instead of a code. Each code works once. Keep them somewhere safe, like a password manager. We won&apos;t show
        them again.
      </Text>
      <View
        accessibilityLabel="Recovery codes"
        style={{ boxShadow: shadows.surface }}
        className="flex-row flex-wrap rounded-surface bg-card px-5 py-4"
      >
        {codes.map((c) => (
          <Text
            key={c}
            selectable
            maxFontSizeMultiplier={1.3}
            style={{ fontFamily: MONO, letterSpacing: 0.5 }}
            className="w-1/2 py-1.5 text-[15px] text-foreground"
          >
            {c}
          </Text>
        ))}
      </View>
      <Button variant="outline" onPress={() => void clipboard.copy(codes.join("\n"))}>
        {clipboard.copied ? "Copied" : "Copy all"}
      </Button>
      {clipboard.copied && (
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          Paste them into your password manager. For your security, LinkPay clears them from your clipboard after a
          minute.
        </Text>
      )}
      <Button onPress={onDone}>I&apos;ve saved them</Button>
    </View>
  );
}
