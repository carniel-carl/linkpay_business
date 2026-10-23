import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking, ScrollView, Switch, Text, View } from "react-native";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { can, useMemberships, useOverview } from "@/lib/api/banking";
import { useUnreadCount } from "@/lib/api/notifications";
import { askForPush, pushStatus, type PushStatus } from "@/lib/push";
import { useAuth } from "@/lib/auth/store";
import { capitalized, getBiometry, type Biometry } from "@/lib/security/biometrics";
import { LOCK_AFTER_BACKGROUND_MS, LOCK_AFTER_IDLE_MS } from "@/lib/security/app-lock";
import { Icon } from "@/components/ui/icon";
import { useTheme, useThemePreference, type ThemePreference } from "@/theme/theme";
import * as Application from "expo-application";

export default function More() {
  const { colors } = useTheme();
  const { profile, biometrics, biometricSignIn, updateBiometrics, lock, signOut } = useAuth();
  const [biometry, setBiometry] = useState<Biometry>();
  const { preference, setPreference } = useThemePreference();
  const overview = useOverview();
  const memberships = useMemberships();
  const business = overview.data?.business;

  useEffect(() => {
    void getBiometry().then(setBiometry);
  }, []);

  async function toggle(key: "unlock" | "signIn", on: boolean) {
    const result = await updateBiometrics(
      { unlock: biometrics, signIn: biometricSignIn, [key]: on },
      `Use ${biometry?.label ?? "biometrics"} for LinkPay Business`,
    );
    if (!result.ok && result.message) Alert.alert("That didn't work", result.message);
  }

  function confirmSignOut() {
    if (!biometricSignIn) {
      Alert.alert("Sign out of this phone?", "You'll need your email and password to sign in again, and you'll set a new passcode.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOut("signedOut") },
      ]);
      return;
    }
    // With biometric sign-in, signing out keeps the phone ready for Face ID; forgetting it is the explicit choice.
    Alert.alert("Sign out of this phone?", `You can sign back in with ${label}. To remove your details from this phone too, choose Sign out and forget.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", onPress: () => void signOut("signedOut") },
      { text: "Sign out and forget", style: "destructive", onPress: () => void signOut("signedOut", { forget: true }) },
    ]);
  }

  const label = biometry?.label ?? "biometrics";
  const Label = capitalized(label);
  const bioIcon = { ios: biometry?.kind === "face" ? "faceid" : "touchid", android: biometry?.kind === "face" ? "face" : "fingerprint" } as const;
  const bioSwitch = (key: "unlock" | "signIn", value: boolean, a11y: string) => (
    <Switch
      value={value}
      onValueChange={(v) => void toggle(key, v)}
      trackColor={{ true: colors.primary, false: colors.input }}
      accessibilityLabel={a11y}
    />
  );

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-7 px-4 pb-12 pt-2">
      <FocusStatusBar />
      {business && (
        <ListSection title="Business">
          <ListRow
            icon={{ ios: "building.2", android: "store" }}
            title={business.name}
            detail="Business details and verification"
            onPress={() => router.push("/more/business")}
          />
          {business.status === "approved" && (
            <ListRow icon={{ ios: "storefront", android: "storefront" }} title="Branches" onPress={() => router.push("/more/branches")} />
          )}
          {business.status === "approved" && can(overview.data, "accounts.view") && (
            <ListRow
              icon={{ ios: "banknote", android: "savings" }}
              title="Savings"
              detail="Pockets for VAT, payroll, rent and more"
              onPress={() => router.push("/savings")}
            />
          )}
          {business.status === "approved" && can(overview.data, "accounts.view") && (
            <ListRow
              icon={{ ios: "link", android: "link" }}
              title="Payment links"
              detail="Get paid with a link or your website"
              onPress={() => router.push("/payment-links")}
            />
          )}
          {business.status === "approved" && can(overview.data, "invoices.manage") && (
            <ListRow
              icon={{ ios: "paintpalette", android: "palette" }}
              title="Invoice branding"
              detail="Logo, colour and invoice defaults"
              onPress={() => router.push("/more/branding")}
            />
          )}
          {(memberships.data?.length ?? 0) > 1 && (
            <ListRow icon={{ ios: "arrow.left.arrow.right", android: "swap_horiz" }} title="Switch business" onPress={() => router.push("/more/switch-business")} />
          )}
        </ListSection>
      )}

      <NotificationsSection />

      <ListSection
        title="Security"
        footer={`LinkPay locks when you've been away for ${LOCK_AFTER_BACKGROUND_MS / 60_000} minute or idle for ${LOCK_AFTER_IDLE_MS / 60_000} minutes.`}
      >
        {biometry?.available ? (
          <ListRow icon={bioIcon} title={`Unlock with ${Label}`} trailing={bioSwitch("unlock", biometrics, `Unlock with ${Label}`)} />
        ) : (
          <ListRow icon={{ ios: "faceid", android: "fingerprint" }} title="Biometric unlock" detail="Set up Face ID or a fingerprint in your phone's settings to use it here." />
        )}
        <ListRow icon={{ ios: "key", android: "key" }} title="Password" onPress={() => router.push("/more/password")} />
        <ListRow
          icon={{ ios: "lock.rectangle", android: "pin" }}
          title="Transaction PIN"
          detail="Confirms payments and team changes"
          onPress={() => router.push("/more/transaction-pin")}
        />
        <ListRow icon={{ ios: "checkmark.shield", android: "verified_user" }} title="Two-step verification" onPress={() => router.push("/more/security")} />
        <ListRow icon={{ ios: "lock.rotation", android: "password" }} title="Change passcode" onPress={() => router.push("/more/change-passcode")} />
        <ListRow icon={{ ios: "iphone", android: "devices" }} title="Signed-in devices" onPress={() => router.push("/more/devices")} />
        <ListRow icon={{ ios: "lock.fill", android: "lock" }} title="Lock now" chevron={false} onPress={() => lock(true)} />
      </ListSection>

      {biometry?.available && (
        <ListSection
          title="Sign-in"
          footer={`Sign back in on this phone with ${label} after you sign out or your session ends, without your password. Signing this phone out from another device turns it off.`}
        >
          <ListRow
            icon={{ ios: "person.badge.key", android: "passkey" }}
            title={`Sign in with ${Label}`}
            trailing={bioSwitch("signIn", biometricSignIn, `Sign in with ${Label}`)}
          />
        </ListSection>
      )}

      <ListSection title="Appearance" footer="System follows your phone's light or dark setting.">
        {APPEARANCES.map((a) => (
          <ListRow
            key={a.value}
            icon={a.icon}
            title={a.title}
            chevron={false}
            selected={preference === a.value}
            onPress={() => setPreference(a.value)}
            trailing={preference === a.value && <Icon ios="checkmark" android="check" size={17} color={colors.primary} />}
          />
        ))}
      </ListSection>

      <ListSection title="Help">
        <ListRow
          icon={{ ios: "questionmark.circle", android: "help" }}
          title="Questions and answers"
          detail="Transfers, savings, invoices, team and security"
          onPress={() => router.push("/more/help")}
        />
      </ListSection>

      <ListSection title="Account">
        <ListRow
          icon={{ ios: "person.crop.circle", android: "account_circle" }}
          title={profile?.firstName ?? "Signed in"}
          detail={profile?.email}
          onPress={() => router.push("/more/profile")}
        />
        <ListRow icon={{ ios: "rectangle.portrait.and.arrow.right", android: "logout" }} title="Sign out" destructive chevron={false} onPress={confirmSignOut} />
      </ListSection>

      <View className="items-center">
        <Text className="text-[13px] text-muted-foreground">
          LinkPay Business {Application.nativeApplicationVersion ?? ""}
        </Text>
      </View>
    </ScrollView>
  );
}

const APPEARANCES: { value: ThemePreference; title: string; icon: Parameters<typeof ListRow>[0]["icon"] }[] = [
  { value: "system", title: "System", icon: { ios: "circle.lefthalf.filled", android: "contrast" } },
  { value: "light", title: "Light", icon: { ios: "sun.max", android: "light_mode" } },
  { value: "dark", title: "Dark", icon: { ios: "moon", android: "dark_mode" } },
];

const PUSH_DETAIL: Record<PushStatus, string> = {
  granted: "On. Payments, transfers, invoices and account changes",
  undetermined: "Off. Tap to turn on",
  denied: "Off. Turn them on in your phone's settings",
  unavailable: "Not in this version of the app yet",
};

/**
 * The inbox, and whether this phone gets pushes. Tapping the push row asks (first time) or opens the phone's
 * settings (after a refusal). The status is checked again on return to the app, since it changes in Settings.
 */
function NotificationsSection() {
  const [status, setStatus] = useState<PushStatus>();
  const unread = useUnreadCount().data?.total ?? 0;
  useEffect(() => {
    let live = true;
    const check = () => void pushStatus().then((s) => live && setStatus(s));
    check();
    const sub = AppState.addEventListener("change", (state) => state === "active" && check());
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return (
    <ListSection title="Notifications">
      <ListRow
        icon={{ ios: "bell", android: "notifications" }}
        title="Notifications"
        detail={unread ? (unread === 1 ? "1 unread" : `${unread} unread`) : undefined}
        onPress={() => router.push("/notifications")}
      />
      <ListRow
        icon={{ ios: "app.badge", android: "notifications_active" }}
        title="Push notifications"
        detail={status ? PUSH_DETAIL[status] : " "}
        chevron={status === "undetermined" || status === "denied"}
        onPress={
          status === "undetermined"
            ? () => void askForPush().then(setStatus)
            : status === "denied"
              ? () => void Linking.openSettings()
              : undefined
        }
      />
    </ListSection>
  );
}
