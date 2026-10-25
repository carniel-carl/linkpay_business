import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { CodeForm } from "@/components/auth/code-form";
import { RecoveryCodesView } from "@/components/security/recovery-codes";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { ListRow, ListSection } from "@/components/ui/list";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { PasswordField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { useDisableTwoFactor, useEnableEmailTwoFactor, useMe, useNewRecoveryCodes } from "@/lib/api/account";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { FEW_RECOVERY_CODES } from "@/lib/recovery-codes";
import { useTheme } from "@/theme/theme";

type Confirm = "email" | "disable" | "codes" | null;

/** Two-step verification for password sign-ins: an authenticator app or email codes. Mirrors the web's Security tab. */
export default function Security() {
  const { shadows } = useTheme();
  const me = useMe();
  const [confirm, setConfirm] = useState<Confirm>(null);
  // New recovery codes: shown once, in this screen's state only.
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const tf = me.data?.twoFactor;
  const email = me.data?.email ?? "your email";
  const totp = !!tf?.enabled && tf.method === "totp";
  const left = tf?.recoveryCodesLeft ?? 0;

  // They can't be shown again, so while they're up only "I've saved them" leaves (no swipe back, no Back button).
  const screenOptions = <Stack.Screen options={{ gestureEnabled: !newCodes, headerBackVisible: !newCodes }} />;

  if (newCodes) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-4 pb-12 pt-4">
        <FocusStatusBar />
        {screenOptions}
        <Text className="px-1 text-[15px] font-semibold text-foreground">Save your new recovery codes. Your old ones no longer work.</Text>
        <RecoveryCodesView codes={newCodes} onDone={() => setNewCodes(null)} />
      </ScrollView>
    );
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-7 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {screenOptions}
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

          {totp && (
            <View className="gap-3">
              {left === 0 ? (
                <View accessibilityRole="alert" className="rounded-field bg-destructive-subtle px-4 py-3">
                  <Text className="text-[14px] leading-5 text-destructive-foreground">
                    You have no recovery codes left. If you lose your phone, you won&apos;t be able to sign in. Get new codes now.
                  </Text>
                </View>
              ) : (
                left <= FEW_RECOVERY_CODES && (
                  <View className="rounded-field bg-warning-subtle px-4 py-3">
                    <Text className="text-[14px] leading-5 text-warning-foreground">
                      Only {left} recovery {left === 1 ? "code" : "codes"} left. Get new codes before you run out.
                    </Text>
                  </View>
                )
              )}
              <ListSection title="Recovery codes" footer="For when you can't use your authenticator app. Each code works once.">
                <ListRow
                  icon={{ ios: "key.horizontal", android: "key" }}
                  title="Get new codes"
                  detail={`${left} left`}
                  onPress={() => setConfirm("codes")}
                />
              </ListSection>
            </View>
          )}

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

          {confirm === "codes" ? (
            <NewRecoveryCodes
              hasPassword={me.data.hasPassword !== false}
              onCodes={(codes) => {
                setConfirm(null);
                setNewCodes(codes);
              }}
              onCancel={() => setConfirm(null)}
            />
          ) : (
            confirm && <ConfirmPassword key={confirm} mode={confirm} email={email} totp={totp} onDone={() => setConfirm(null)} />
          )}
        </>
      )}
    </KeyboardAwareScrollView>
  );
}

/** Email codes and turning off both need the password, as on the web. */
function ConfirmPassword({ mode, email, totp, onDone }: { mode: "email" | "disable"; email: string; totp: boolean; onDone: () => void }) {
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
        {totp && " Your recovery codes will stop working."}
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

type Proof = "password" | "code";

/** New recovery codes need the password or a current authenticator code, as authenticator setup does on the web. */
function NewRecoveryCodes({ hasPassword, onCodes, onCancel }: { hasPassword: boolean; onCodes: (codes: string[]) => void; onCancel: () => void }) {
  const [proof, setProof] = useState<Proof>(hasPassword ? "password" : "code");
  const [password, setPassword] = useState("");
  const mutation = useNewRecoveryCodes();

  function submitPassword() {
    if (!password) return;
    mutation.mutate({ password }, { onSuccess: (res) => onCodes(res.recoveryCodes) });
  }

  async function submitCode(code: string) {
    try {
      onCodes((await mutation.mutateAsync({ code })).recoveryCodes);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CODE") return "That code didn't work. Enter the current code from your authenticator app.";
      throw err;
    }
  }

  return (
    <View className="gap-4">
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">
        {hasPassword
          ? "Confirm it's you with your password or a code from your authenticator app."
          : "Confirm it's you with a code from your authenticator app."}
      </Text>
      <View className="rounded-field bg-warning-subtle px-4 py-3">
        <Text className="text-[14px] leading-5 text-warning-foreground">Your current recovery codes stop working as soon as you get new ones.</Text>
      </View>
      {hasPassword && (
        <Segmented
          label="Confirm with"
          segments={[
            { key: "password", label: "Password" },
            { key: "code", label: "Authenticator code" },
          ]}
          value={proof}
          onChange={(next) => {
            mutation.reset();
            setProof(next);
          }}
        />
      )}
      {proof === "password" ? (
        <>
          <FormError message={mutation.error ? friendlyMessage(mutation.error) : undefined} />
          <PasswordField label="Password" value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" autoFocus returnKeyType="go" onSubmitEditing={submitPassword} />
          <Button loading={mutation.isPending} disabled={!password} onPress={submitPassword}>
            Get new codes
          </Button>
        </>
      ) : (
        <CodeForm label="Authenticator code" submitLabel="Get new codes" onSubmit={submitCode} />
      )}
      <Button variant="ghost" onPress={onCancel}>
        Cancel
      </Button>
    </View>
  );
}
