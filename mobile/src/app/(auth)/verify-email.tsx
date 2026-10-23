import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { AuthScreen, FooterPrompt, Strong } from "@/components/auth/auth-screen";
import { CodeForm } from "@/components/auth/code-form";
import { ResendCode } from "@/components/auth/resend-code";
import { TextButton } from "@/components/ui/button";
import { resendVerification, verifyEmail } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";

export default function VerifyEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const signedIn = useAuth((s) => s.signedIn);
  if (!email) return <Redirect href="/sign-up" />;

  return (
    <AuthScreen
      title="Check your email"
      description={
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          We sent a 6-digit code to <Strong>{email}</Strong>. It expires in 10 minutes.
        </Text>
      }
      footer={
        <View className="gap-3">
          <FooterPrompt text="Wrong email?">
            <TextButton onPress={() => router.replace("/sign-up")}>Start again</TextButton>
          </FooterPrompt>
          {/* Signing up with an email that already has an account emails its owner instead of sending a code. */}
          <FooterPrompt text="Already have an account?">
            <TextButton onPress={() => router.replace({ pathname: "/sign-in", params: { email } })}>Sign in</TextButton>
          </FooterPrompt>
        </View>
      }
    >
      <CodeForm
        label="Verification code"
        submitLabel="Verify email"
        onSubmit={async (code) => {
          await signedIn(await verifyEmail(email, code));
        }}
      >
        <ResendCode onResend={() => resendVerification(email)} />
      </CodeForm>
    </AuthScreen>
  );
}
