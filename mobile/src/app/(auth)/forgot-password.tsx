import { zodResolver } from "@hookform/resolvers/zod";
import { router, useLocalSearchParams } from "expo-router";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";
import { AuthScreen, FooterPrompt } from "@/components/auth/auth-screen";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { TextField } from "@/components/ui/text-field";
import { requestPasswordReset } from "@/lib/auth/api";
import { applyError } from "@/lib/forms";
import { emailOnlySchema } from "@/lib/schemas";

type Values = z.infer<typeof emailOnlySchema>;

/** The backend answers the same whether or not the email has an account, so this always moves on to the code. */
export default function ForgotPassword() {
  const params = useLocalSearchParams<{ email?: string }>();
  const form = useForm<Values>({ resolver: zodResolver(emailOnlySchema), defaultValues: { email: params.email ?? "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      await requestPasswordReset(values.email);
      router.push({ pathname: "/reset-password", params: { email: values.email } });
    } catch (err) {
      applyError(form, err);
    }
  }

  return (
    <AuthScreen
      title="Reset your password"
      description="Enter the email you sign in with. We'll send a 6-digit code so you can choose a new password."
      footer={
        <FooterPrompt text="Remembered it?">
          <TextButton onPress={() => router.back()}>Sign in</TextButton>
        </FooterPrompt>
      }
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
