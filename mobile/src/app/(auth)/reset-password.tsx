import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { AuthScreen, FooterPrompt, Strong } from "@/components/auth/auth-screen";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Button, TextButton } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/store";

export default function ResetPassword() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [done, setDone] = useState(false);
  if (!email) return <Redirect href="/forgot-password" />;

  if (done) {
    return (
      <AuthScreen title="Password changed" description="We've signed you out on every device. Sign in with your new password.">
        <Button onPress={() => router.dismissTo({ pathname: "/sign-in", params: { email } })}>Sign in</Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Choose a new password"
      description={
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          If <Strong>{email}</Strong> has a LinkPay account, a 6-digit code is on its way. It expires in 10 minutes.
        </Text>
      }
      footer={
        <FooterPrompt text="Wrong email?">
          <TextButton onPress={() => router.back()}>Start again</TextButton>
        </FooterPrompt>
      }
    >
      <ResetPasswordForm
        email={email}
        onDone={async () => {
          // The server ended this account's biometric sign-in too, so a phone that remembers it forgets it.
          const { profile, forgetPhone } = useAuth.getState();
          if (profile?.email.toLowerCase() === email.toLowerCase()) await forgetPhone();
          setDone(true);
        }}
      />
    </AuthScreen>
  );
}
