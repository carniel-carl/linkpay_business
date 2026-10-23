import { zodResolver } from "@hookform/resolvers/zod";
import type { OTPInputRef } from "input-otp-native";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";
import { ResendCode } from "@/components/auth/resend-code";
import { Button } from "@/components/ui/button";
import { CodeField } from "@/components/ui/code-field";
import { FormError } from "@/components/ui/form-error";
import { PasswordField, type TextInputRef } from "@/components/ui/text-field";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { requestPasswordReset, resetPassword } from "@/lib/auth/api";
import { applyError } from "@/lib/forms";
import { resetPasswordSchema } from "@/lib/schemas";

type Values = z.infer<typeof resetPasswordSchema>;

/**
 * The emailed code, then a new password. Signed out from "Forgot password?", and signed in for an account
 * with no password. When `onDone` runs, the server has ended every session, this phone's included.
 */
export function ResetPasswordForm({ email, onDone }: { email: string; onDone: () => Promise<void> | void }) {
  const code = useRef<OTPInputRef>(null);
  const password = useRef<TextInputRef>(null);
  const form = useForm<Values>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { code: "", newPassword: "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      await resetPassword(email, values.code, values.newPassword);
      await onDone();
    } catch (err) {
      // A wrong code clears the slots for another try, as on the other code screens.
      if (err instanceof ApiError && err.code === "INVALID_CODE") {
        form.setValue("code", "");
        code.current?.clear();
        form.setError("root", { message: friendlyMessage(err) });
      } else applyError(form, err);
    }
  }
  const submit = () => void form.handleSubmit(onSubmit)();

  return (
    <>
      <FormError message={errors.root?.message ?? errors.code?.message} />
      <Controller
        name="code"
        control={form.control}
        render={({ field, fieldState }) => (
          <CodeField
            ref={code}
            label="Reset code"
            value={field.value}
            onChange={field.onChange}
            onComplete={() => password.current?.focus()}
            invalid={!!fieldState.error}
            disabled={isSubmitting}
          />
        )}
      />
      <Controller
        name="newPassword"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            ref={password}
            label="New password"
            hint="At least 8 characters."
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoComplete="new-password"
            textContentType="newPassword"
            passwordRules="minlength: 8;"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        )}
      />
      <Button loading={isSubmitting} onPress={submit}>
        Set new password
      </Button>
      <ResendCode onResend={() => requestPasswordReset(email)} />
    </>
  );
}
