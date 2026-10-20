import { zodResolver } from "@hookform/resolvers/zod";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Text, View } from "react-native";
import type { z } from "zod";
import { AuthScreen, FooterPrompt, Strong } from "@/components/auth/auth-screen";
import { CodeForm } from "@/components/auth/code-form";
import { ResendCode } from "@/components/auth/resend-code";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { TextField } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api/errors";
import { requestSignInCode, signInWithCode } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";
import { applyError } from "@/lib/forms";
import { emailOnlySchema } from "@/lib/schemas";

type Values = z.infer<typeof emailOnlySchema>;

const backToPassword = (
  <FooterPrompt text="Prefer your password?">
    <TextButton onPress={() => router.back()}>Sign in with it instead</TextButton>
  </FooterPrompt>
);

export default function SignInWithCode() {
  const params = useLocalSearchParams<{ email?: string }>();
  const [sentTo, setSentTo] = useState<string>();
  const form = useForm<Values>({ resolver: zodResolver(emailOnlySchema), defaultValues: { email: params.email ?? "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      await requestSignInCode(values.email);
      setSentTo(values.email);
    } catch (err) {
      // A cooldown means a code went out less than a minute ago, so it's still usable.
      if (err instanceof ApiError && err.code === "OTP_COOLDOWN") setSentTo(values.email);
      else applyError(form, err);
    }
  }

  if (sentTo) return <EnterCode email={sentTo} onChangeEmail={() => setSentTo(undefined)} />;

  return (
    <AuthScreen
      title="Sign in with a code"
      description="Enter your email and we'll send you a 6-digit code. No password needed."
      footer={backToPassword}
    >
      <FormError message={errors.root?.message} />
      <Controller
        name="email"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            label="Email"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="send"
            onSubmitEditing={() => void form.handleSubmit(onSubmit)()}
          />
        )}
      />
      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        Send code
      </Button>
    </AuthScreen>
  );
}

function EnterCode({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const { signedIn, setChallenge } = useAuth();
  return (
    <AuthScreen
      title="Check your email"
      description={
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          If <Strong>{email}</Strong> has a LinkPay account, a sign-in code is on its way. It expires in 10 minutes.
        </Text>
      }
      footer={backToPassword}
    >
      <CodeForm
        label="Sign-in code"
        submitLabel="Sign in"
        onSubmit={async (code) => {
          const res = await signInWithCode(email, code);
          if ("twoFactorRequired" in res) {
            setChallenge({ token: res.challengeToken, method: res.method, email });
            router.push("/two-factor");
            return;
          }
          await signedIn(res);
        }}
      >
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <ResendCode onResend={() => requestSignInCode(email)} />
          <TextButton onPress={onChangeEmail}>Use a different email</TextButton>
        </View>
      </CodeForm>
    </AuthScreen>
  );
}
