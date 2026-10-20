import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { CodeForm } from "@/components/auth/code-form";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Figure } from "@/components/ui/typography";
import { startTotpSetup, useEnableTotp } from "@/lib/api/account";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useTheme } from "@/theme/theme";

/**
 * Authenticator setup on the phone itself: the authenticator app is usually on this same phone, so instead
 * of a QR code it opens the app with the otpauth link, or shows the key to type in.
 */
export default function TotpSetup() {
  const { shadows } = useTheme();
  // A new secret each time the screen opens; never cached or refetched behind the user's back.
  const setup = useQuery({ queryKey: ["totp-setup"], queryFn: startTotpSetup, gcTime: 0, staleTime: Infinity, retry: false });
  const enable = useEnableTotp();
  const [copied, setCopied] = useState(false);

  async function openApp() {
    if (!setup.data) return;
    try {
      await Linking.openURL(setup.data.otpauthUrl);
    } catch {
      Alert.alert("No authenticator app found", "Install one (Google Authenticator, Microsoft Authenticator or 1Password), or enter the key below by hand.");
    }
  }

  async function copy() {
    if (!setup.data) return;
    await Clipboard.setStringAsync(setup.data.secret);
    setCopied(true);
  }

  async function submit(code: string) {
    try {
      await enable.mutateAsync(code);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CODE") return "That code didn't work. Enter the current code from your authenticator app.";
      throw err;
    }
    Alert.alert("Authenticator app is set up", "From your next password sign-in, LinkPay asks for a code from the app.");
    router.back();
  }

  const grouped = setup.data?.secret.match(/.{1,4}/g)?.join(" ");

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {setup.isError && <FormError message={friendlyMessage(setup.error)} />}
      <View className="gap-3">
        <Text className="px-1 text-[15px] font-semibold text-foreground">1. Add LinkPay to your authenticator app</Text>
        <Button icon={{ ios: "arrow.up.forward.app", android: "open_in_new" }} disabled={!setup.data} onPress={() => void openApp()}>
          Open authenticator app
        </Button>
        <View style={{ boxShadow: shadows.surface }} className="gap-2 rounded-surface bg-card px-5 py-4">
          <Text className="text-[13px] text-muted-foreground">Or enter this key in the app</Text>
          {grouped ? (
            <Figure size={18} selectable style={{ letterSpacing: 1 }}>
              {grouped}
            </Figure>
          ) : (
            <View className="h-6 w-4/5 rounded bg-muted" />
          )}
          <Button variant="outline" size="sm" className="self-start" disabled={!setup.data} onPress={() => void copy()}>
            {copied ? "Copied" : "Copy key"}
          </Button>
        </View>
      </View>
      <View className="gap-4">
        <Text className="px-1 text-[15px] font-semibold text-foreground">2. Enter the 6-digit code it shows</Text>
        <CodeForm label="Authenticator code" submitLabel="Turn on" onSubmit={submit} />
      </View>
    </KeyboardAwareScrollView>
  );
}
