import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { AuthScreen, FooterPrompt, Strong } from "@/components/auth/auth-screen";
import { CodeForm } from "@/components/auth/code-form";
import { ResendCode } from "@/components/auth/resend-code";
import { TextButton } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import { resendTwoFactor, verifyTwoFactor } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";

export default function TwoFactor() {
  const { signedIn, setChallenge } = useAuth();
  // The store clears the challenge on success; keep the one this screen opened with.
  const [challenge] = useState(() => useAuth.getState().challenge);
  if (!challenge) return <Redirect href="/sign-in" />;
  const { token, email, method } = challenge;
  const totp = method === "totp";

  async function submit(code: string) {
    try {
      await signedIn(await verifyTwoFactor(token, code));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // The 10-minute challenge ran out: the password step has to be repeated.
      if (err.code === "INVALID_TOKEN") {
        setChallenge(undefined);
        router.replace({ pathname: "/sign-in", params: { email } });
        return;
      }
      if (totp && err.code === "INVALID_CODE") return "That code didn't work. Enter the current code from your authenticator app.";
      throw err;
    }
  }

  return (
    <AuthScreen
      title="Two-step verification"
      description={
        totp ? (
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
      <CodeForm label={totp ? "Authenticator code" : "Email code"} submitLabel="Verify and sign in" onSubmit={submit}>
        {!totp && <ResendCode onResend={() => resendTwoFactor(token)} />}
      </CodeForm>
    </AuthScreen>
  );
}
