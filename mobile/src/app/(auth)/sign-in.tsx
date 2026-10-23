import { zodResolver } from "@hookform/resolvers/zod";
import { router, useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { Text, View } from "react-native";
import type { z } from "zod";
import { AuthScreen, FooterPrompt } from "@/components/auth/auth-screen";
import { useBiometricSignIn } from "@/components/auth/use-biometric-sign-in";
import { Button, TextButton } from "@/components/ui/button";
import { FormError, Notice } from "@/components/ui/form-error";
import { PasswordField, TextField, type TextInputRef } from "@/components/ui/text-field";
import { ApiError } from "@/lib/api/errors";
import { signInWithPassword } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";
import { applyError } from "@/lib/forms";
import { signInSchema } from "@/lib/schemas";
import { capitalized } from "@/lib/security/biometrics";

type Values = z.infer<typeof signInSchema>;

const ENDED: Record<string, string> = {
  expired: "Your session ended. Sign in again to continue.",
  revoked: "This phone was signed out from another device. Sign in again to continue.",
  tooManyAttempts: "Too many wrong passcodes, so we signed this phone out. Sign in again to choose a new passcode.",
  passwordSet: "Your password is set, and every device was signed out. Sign in with it to continue.",
};

export default function SignIn() {
  const params = useLocalSearchParams<{ email?: string }>();
  const { endedReason, signedIn, setChallenge } = useAuth();
  const password = useRef<TextInputRef>(null);
  const bio = useBiometricSignIn();
  const form = useForm<Values>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: params.email ?? "", password: "" },
  });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      const res = await signInWithPassword(values.email, values.password);
      if ("twoFactorRequired" in res) {
        setChallenge({ token: res.challengeToken, method: res.method, email: values.email });
        router.push("/two-factor");
        return;
      }
      await signedIn(res);
    } catch (err) {
      // The backend has already emailed a fresh code, so go straight to verification.
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        router.push({ pathname: "/verify-email", params: { email: values.email, resent: "1" } });
        return;
      }
      applyError(form, err);
    }
  }

  return (
    <AuthScreen
      title="Sign in"
      description="Welcome back. Sign in to manage your business account."
      footer={
        <FooterPrompt text="New to LinkPay?">
          <TextButton onPress={() => router.replace("/sign-up")}>Open an account</TextButton>
        </FooterPrompt>
      }
    >
      {endedReason && ENDED[endedReason] && <Notice message={ENDED[endedReason]} />}
      <FormError message={errors.root?.message ?? bio.error} />
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
            textContentType="username"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => password.current?.focus()}
          />
        )}
      />
      <Controller
        name="password"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            ref={password}
            label="Password"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void form.handleSubmit(onSubmit)()}
          />
        )}
      />
      <View className="-mt-2 flex-row justify-end">
        <TextButton onPress={() => router.push({ pathname: "/forgot-password", params: { email: form.getValues("email") } })}>
          Forgot password?
        </TextButton>
      </View>
      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        Sign in
      </Button>
      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-[13px] text-muted-foreground">or</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
      <Button
        variant="outline"
        icon={{ ios: "envelope", android: "mail" }}
        onPress={() => router.push({ pathname: "/sign-in-code", params: { email: form.getValues("email") } })}
      >
        Email me a sign-in code
      </Button>
      {bio.available && (
        <Button
          variant="outline"
          loading={bio.busy}
          icon={{ ios: bio.biometry?.kind === "face" ? "faceid" : "touchid", android: bio.biometry?.kind === "face" ? "face" : "fingerprint" }}
          onPress={() => void bio.signIn()}
        >
          {`Sign in with ${capitalized(bio.label)}`}
        </Button>
      )}
    </AuthScreen>
  );
}
