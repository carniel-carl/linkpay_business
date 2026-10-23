import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Text, View } from "react-native";
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

/** How long a copied key stays on the clipboard: time to paste it into the authenticator app. */
const KEY_ON_CLIPBOARD_MS = 60_000;

/**
 * Copies the key, and takes it off the clipboard after a minute or when this screen closes, but only if it's
 * still the key there: anything copied since is left alone. Not on going to the background, since that's
 * where it gets pasted. Android also keeps it out of the clipboard preview; expo-clipboard has no expiring
 * or this-device-only copy on iOS. `copied` is true while the key may still be on the clipboard.
 */
function useCopyKey() {
  const [copied, setCopied] = useState(false);
  const onClipboard = useRef<{ key: string; until: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clear = useCallback(async (now = false) => {
    const c = onClipboard.current;
    // Android doesn't let an app in the background read the clipboard, so that waits until it's back.
    if (!c || (!now && Date.now() < c.until) || AppState.currentState !== "active") return;
    onClipboard.current = null;
    setCopied(false);
    if ((await Clipboard.getStringAsync().catch(() => "")) === c.key) await Clipboard.setStringAsync("").catch(() => false);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void clear();
    });
    return () => {
      sub.remove();
      clearTimeout(timer.current);
      void clear(true);
    };
  }, [clear]);

  async function copy(key: string) {
    await Clipboard.setStringAsync(key, { android: { isSensitive: true } });
    onClipboard.current = { key, until: Date.now() + KEY_ON_CLIPBOARD_MS };
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void clear(true), KEY_ON_CLIPBOARD_MS);
  }

  return { copied, copy };
}

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
  const clipboard = useCopyKey();

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
    await clipboard.copy(setup.data.secret);
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
            {clipboard.copied ? "Copied" : "Copy key"}
          </Button>
          {clipboard.copied && (
            <Text className="text-[13px] leading-[18px] text-muted-foreground">
              Paste it into your authenticator app. For your security, LinkPay clears it from your clipboard after a
              minute.
            </Text>
          )}
        </View>
      </View>
      <View className="gap-4">
        <Text className="px-1 text-[15px] font-semibold text-foreground">2. Enter the 6-digit code it shows</Text>
        <CodeForm label="Authenticator code" submitLabel="Turn on" onSubmit={submit} />
      </View>
    </KeyboardAwareScrollView>
  );
}
