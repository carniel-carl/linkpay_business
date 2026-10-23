import { zodResolver } from "@hookform/resolvers/zod";
import { router } from "expo-router";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";
import { AuthScreen, FooterPrompt } from "@/components/auth/auth-screen";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { PasswordField, TextField, type TextInputRef } from "@/components/ui/text-field";
import { register } from "@/lib/auth/api";
import { applyError } from "@/lib/forms";
import { signUpSchema } from "@/lib/schemas";

type Values = z.infer<typeof signUpSchema>;

export default function SignUp() {
  const emailRef = useRef<TextInputRef>(null);
  const passwordRef = useRef<TextInputRef>(null);
  const form = useForm<Values>({ resolver: zodResolver(signUpSchema), defaultValues: { name: "", email: "", password: "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      // The same answer whether or not the email has an account, so every sign-up goes on to the code.
      await register(values);
      router.push({ pathname: "/verify-email", params: { email: values.email } });
    } catch (err) {
      applyError(form, err);
    }
  }

  return (
    <AuthScreen
      title="Open a business account"
      description="Start with your own details. You'll add your business and its documents next."
      footer={
        <FooterPrompt text="Already have an account?">
          <TextButton onPress={() => router.replace("/sign-in")}>Sign in</TextButton>
        </FooterPrompt>
      }
    >
      <FormError message={errors.root?.message} />
      <Controller
        name="name"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            label="Full name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => emailRef.current?.focus()}
          />
        )}
      />
      <Controller
        name="email"
        control={form.control}
        render={({ field, fieldState }) => (
          <TextField
            ref={emailRef}
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
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        )}
      />
      <Controller
        name="password"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            ref={passwordRef}
            label="Password"
            hint="At least 8 characters."
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoComplete="new-password"
            textContentType="newPassword"
            passwordRules="minlength: 8;"
            returnKeyType="go"
            onSubmitEditing={() => void form.handleSubmit(onSubmit)()}
          />
        )}
      />
      <Button loading={isSubmitting} onPress={() => void form.handleSubmit(onSubmit)()}>
        Create account
      </Button>
    </AuthScreen>
  );
}
