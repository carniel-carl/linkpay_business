import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { AuthScreen, FooterPrompt, Strong } from "@/components/auth/auth-screen";
import { CodeForm } from "@/components/auth/code-form";
import { ResendCode } from "@/components/auth/resend-code";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { TextField } from "@/components/ui/text-field";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import type { TwoFactorSession } from "@/lib/api/types";
import { resendTwoFactor, verifyTwoFactor } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";
import { noteRecoveryCodeUsed } from "@/lib/recovery-codes";

export default function TwoFactor() {
  const { signedIn, setChallenge } = useAuth();
  // The store clears the challenge on success; keep the one this screen opened with.
  const [challenge] = useState(() => useAuth.getState().challenge);
  // Recovery codes only exist for the authenticator app.
  const [recovery, setRecovery] = useState(false);
  if (!challenge) return <Redirect href="/sign-in" />;
  const { token, email, method } = challenge;
  const totp = method === "totp";

  async function finish(session: TwoFactorSession) {
    await signedIn(session);
    if (session.recoveryCodeUsed) noteRecoveryCodeUsed(session.recoveryCodesLeft ?? 0);
  }

  /** A challenge past its 10 minutes: the password step has to be repeated. Returns true when it was that. */
  function expired(err: unknown) {
    if (!(err instanceof ApiError) || err.code !== "INVALID_TOKEN") return false;
    setChallenge(undefined);
    router.replace({ pathname: "/sign-in", params: { email } });
    return true;
  }

  async function submit(code: string) {
    try {
      await finish(await verifyTwoFactor(token, { code }));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (expired(err)) return;
      if (totp && err.code === "INVALID_CODE") return "That code didn't work. Enter the current code from your authenticator app.";
      throw err;
    }
  }

  return (
    <AuthScreen
      title="Two-step verification"
      description={
        recovery ? (
          "Enter one of the recovery codes you saved when you set up your authenticator app."
        ) : totp ? (
          "Open your authenticator app and enter the 6-digit code for LinkPay."
        ) : (
          <Text className="text-[15px] leading-[22px] text-muted-foreground">
            We sent a 6-digit code to <Strong>{email}</Strong>.
          </Text>
        )
      }
      footer={
        <FooterPrompt text="Not you?">
          <TextButton onPress={() => router.back()}>Back to sign in</TextButton>
        </FooterPrompt>
      }
    >
      {recovery ? (
        <RecoveryCodeForm onSubmit={async (recoveryCode) => finish(await verifyTwoFactor(token, { recoveryCode }))} onExpired={expired} />
      ) : (
        <CodeForm label={totp ? "Authenticator code" : "Email code"} submitLabel="Verify and sign in" onSubmit={submit}>
          {!totp && <ResendCode onResend={() => resendTwoFactor(token)} />}
        </CodeForm>
      )}
      {totp && (
        <View className="flex-row flex-wrap items-center gap-x-1.5">
          <Text className="text-[14px] text-muted-foreground">{recovery ? "Have your phone?" : "Can't use your authenticator app?"}</Text>
          <TextButton onPress={() => setRecovery((r) => !r)}>
            {recovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
          </TextButton>
        </View>
      )}
    </AuthScreen>
  );
}

/** One of the saved recovery codes. Spaces, dashes and capitals don't matter to the backend. */
function RecoveryCodeForm({ onSubmit, onExpired }: { onSubmit: (code: string) => Promise<void>; onExpired: (err: unknown) => boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    const code = value.trim();
    if (!code) return setError("Enter one of your recovery codes.");
    setError(undefined);
    setPending(true);
    try {
      await onSubmit(code);
    } catch (err) {
      if (onExpired(err)) return;
      setError(
        err instanceof ApiError && err.code === "INVALID_CODE"
          ? "That recovery code didn't work. Check it, or try another you haven't used yet."
          : friendlyMessage(err),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <FormError message={error} />
      <TextField
        label="Recovery code"
        value={value}
        onChangeText={setValue}
        placeholder="abcde-fghjk"
        hint="Each code works once."
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        autoFocus
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!pending}
      />
      <Button loading={pending} disabled={!value.trim()} onPress={() => void submit()}>
        Verify and sign in
      </Button>
    </>
  );
}
