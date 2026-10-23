import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { CodeForm } from "@/components/auth/code-form";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { PasswordField } from "@/components/ui/text-field";
import { Figure } from "@/components/ui/typography";
import { useEnableTotp } from "@/lib/api/account";
import { api } from "@/lib/api/client";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useTheme } from "@/theme/theme";

// Setup needs the password, so a stolen session alone can't add an authenticator.
const startSetup = (password: string) =>
  api<{ secret: string; otpauthUrl: string }>("/api/auth/2fa/totp/setup", { method: "POST", json: { password } });

/**
 * Authenticator setup on the phone itself: the authenticator app is usually on this same phone, so instead
 * of a QR code it opens the app with the otpauth link, or shows the key to type in.
 */
export default function TotpSetup() {
  const { shadows } = useTheme();
  // A new secret each time the screen opens, once the password is confirmed; never cached or refetched.
  const setup = useMutation({ mutationFn: startSetup });
  const enable = useEnableTotp();
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  function start() {
    if (password) setup.mutate(password);
  }

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

  if (!setup.data) {
    return (
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-4 pb-12 pt-4">
        <FocusStatusBar />
        <Text className="px-1 text-[15px] leading-[22px] text-foreground">Confirm your password to add an authenticator app.</Text>
        <FormError message={setup.error ? friendlyMessage(setup.error) : undefined} />
        <PasswordField label="Password" value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" autoFocus returnKeyType="go" onSubmitEditing={start} />
        <Button loading={setup.isPending} disabled={!password} onPress={start}>
          Continue
        </Button>
      </KeyboardAwareScrollView>
    );
  }

  const grouped = setup.data.secret.match(/.{1,4}/g)?.join(" ");

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <View className="gap-3">
        <Text className="px-1 text-[15px] font-semibold text-foreground">1. Add LinkPay to your authenticator app</Text>
        <Button icon={{ ios: "arrow.up.forward.app", android: "open_in_new" }} onPress={() => void openApp()}>
          Open authenticator app
        </Button>
        <View style={{ boxShadow: shadows.surface }} className="gap-2 rounded-surface bg-card px-5 py-4">
          <Text className="text-[13px] text-muted-foreground">Or enter this key in the app</Text>
          <Figure size={18} selectable style={{ letterSpacing: 1 }}>
            {grouped}
          </Figure>
          <Button variant="outline" size="sm" className="self-start" onPress={() => void copy()}>
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
