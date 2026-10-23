import { zodResolver } from "@hookform/resolvers/zod";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import type { z } from "zod";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { PasswordField, type TextInputRef } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { useMe } from "@/lib/api/account";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { changePassword, requestPasswordReset } from "@/lib/auth/api";
import { useAuth } from "@/lib/auth/store";
import { applyError } from "@/lib/forms";
import { changePasswordSchema } from "@/lib/schemas";
import { useTheme } from "@/theme/theme";

/**
 * Change the password (other devices are signed out, this phone stays in). An account whose password was
 * removed when its email was verified sets one with an emailed code instead. Mirrors the web's Security tab.
 */
export default function Password() {
  const me = useMe();
  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {me.isError && <FormError message={friendlyMessage(me.error)} />}
      {!me.data ? (
        <View className="h-40 rounded-surface bg-muted" />
      ) : me.data.hasPassword === false ? (
        <SetPassword email={me.data.email} />
      ) : (
        <ChangePassword />
      )}
    </KeyboardAwareScrollView>
  );
}

type Values = z.infer<typeof changePasswordSchema>;

function ChangePassword() {
  const next = useRef<TextInputRef>(null);
  const form = useForm<Values>({ resolver: zodResolver(changePasswordSchema), defaultValues: { currentPassword: "", newPassword: "" } });
  const { isSubmitting, errors } = form.formState;

  async function onSubmit(values: Values) {
    try {
      await changePassword(values.currentPassword, values.newPassword);
      Alert.alert("Password changed", "Your other devices are signed out. This phone stays signed in.");
      router.back();
    } catch (err) {
      if (err instanceof ApiError && err.code === "INCORRECT_PASSWORD") form.setError("currentPassword", { message: friendlyMessage(err) });
      else applyError(form, err);
    }
  }
  const submit = () => void form.handleSubmit(onSubmit)();

  return (
    <>
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">
        Changing your password signs you out on every other device. This phone stays signed in.
      </Text>
      <FormError message={errors.root?.message} />
      <Controller
        name="currentPassword"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            label="Current password"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error?.message}
            autoComplete="current-password"
            textContentType="password"
            autoFocus
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => next.current?.focus()}
          />
        )}
      />
      <Controller
        name="newPassword"
        control={form.control}
        render={({ field, fieldState }) => (
          <PasswordField
            ref={next}
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
        Change password
      </Button>
    </>
  );
}

/** Setting a password is a reset: it ends every session, this phone's too, so the app signs out afterwards. */
function SetPassword({ email }: { email: string }) {
  const { shadows } = useTheme();
  const signOut = useAuth((s) => s.signOut);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  async function send() {
    setSending(true);
    setError(undefined);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <>
        <Text className="px-1 text-[15px] leading-[22px] text-foreground">
          Enter the code we sent to {email} and choose a password. Then sign in again with it.
        </Text>
        <ResetPasswordForm email={email} onDone={() => signOut("passwordSet", { forget: true })} />
      </>
    );
  }

  return (
    <>
      <View style={{ boxShadow: shadows.surface }} className="gap-1 rounded-surface bg-card px-5 py-4">
        <Text className="text-[13px] text-muted-foreground">Password</Text>
        <Display size={22}>Not set</Display>
        <Text className="text-[14px] leading-5 text-muted-foreground">
          You sign in with codes we email to {email}. Set a password to sign in with it too.
        </Text>
      </View>
      <FormError message={error} />
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">
        We'll email you a code to choose one. Setting it signs you out on every device, this phone too.
      </Text>
      <Button loading={sending} onPress={() => void send()}>
        Email me a code
      </Button>
    </>
  );
}
