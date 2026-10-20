import { router } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { PasswordField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { useDisableTwoFactor, useEnableEmailTwoFactor, useMe } from "@/lib/api/account";
import { friendlyMessage } from "@/lib/api/errors";
import { useTheme } from "@/theme/theme";

type Confirm = "email" | "disable" | null;

/** Two-step verification for password sign-ins: an authenticator app or email codes. Mirrors the web's Security tab. */
export default function Security() {
  const { shadows } = useTheme();
  const me = useMe();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const tf = me.data?.twoFactor;
  const email = me.data?.email ?? "your email";

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-7 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {me.isError && <FormError message={friendlyMessage(me.error)} />}
      {!me.data ? (
        <View className="h-40 rounded-surface bg-muted" />
      ) : (
        <>
          <View style={{ boxShadow: shadows.surface }} className="gap-1 rounded-surface bg-card px-5 py-4">
            <Text className="text-[13px] text-muted-foreground">Two-step verification</Text>
            <Display size={22}>{tf?.enabled ? (tf.method === "totp" ? "On: authenticator app" : "On: email codes") : "Off"}</Display>
            <Text className="text-[14px] leading-5 text-muted-foreground">
              {tf?.enabled
                ? "After your password, LinkPay asks for a code. Someone with only your password can't sign in."
                : "Add a code after your password, so someone with only your password can't sign in."}
            </Text>
          </View>

          <ListSection
            title={tf?.enabled ? "Change method" : "Turn it on"}
            footer="Signing back in with Face ID or a fingerprint on a phone you've already verified doesn't ask for a code."
          >
            {tf?.method !== "totp" && (
              <ListRow
                icon={{ ios: "lock.shield", android: "phonelink_lock" }}
                title="Authenticator app"
                detail="Google Authenticator, Microsoft Authenticator, 1Password or any app that shows 6-digit codes. Works without network."
                onPress={() => router.push("/more/totp")}
              />
            )}
            {tf?.method !== "email" && (
              <ListRow
                icon={{ ios: "envelope", android: "mail" }}
                title="Email codes"
                detail={`We email a code to ${email} each time you sign in with your password.`}
                onPress={() => setConfirm("email")}
              />
            )}
            {tf?.enabled && (
              <ListRow icon={{ ios: "xmark.shield", android: "remove_moderator" }} title="Turn off" destructive chevron={false} onPress={() => setConfirm("disable")} />
            )}
          </ListSection>

          {confirm && <ConfirmPassword key={confirm} mode={confirm} email={email} onDone={() => setConfirm(null)} />}
        </>
      )}
    </KeyboardAwareScrollView>
  );
}

/** Email codes and turning off both need the password, as on the web. */
function ConfirmPassword({ mode, email, onDone }: { mode: Exclude<Confirm, null>; email: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const enable = useEnableEmailTwoFactor();
  const disable = useDisableTwoFactor();
  const mutation = mode === "email" ? enable : disable;

  function submit() {
    if (!password) return;
    mutation.mutate(password, {
      onSuccess: () => {
        Alert.alert(mode === "email" ? "Email codes are on" : "Two-step verification is off");
        onDone();
      },
    });
  }

  return (
    <View className="gap-4">
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">
        {mode === "email"
          ? `Confirm your password. From your next sign-in, we'll email a code to ${email}.`
          : "Confirm your password. You'll sign in with your password alone."}
      </Text>
      <FormError message={mutation.error ? friendlyMessage(mutation.error) : undefined} />
      <PasswordField label="Password" value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" autoFocus returnKeyType="go" onSubmitEditing={submit} />
      <View className="gap-3">
        <Button variant={mode === "disable" ? "destructive" : "primary"} loading={mutation.isPending} disabled={!password} onPress={submit}>
          {mode === "email" ? "Turn on email codes" : "Turn off two-step verification"}
        </Button>
        <Button variant="ghost" onPress={onDone}>
          Cancel
        </Button>
      </View>
    </View>
  );
}
