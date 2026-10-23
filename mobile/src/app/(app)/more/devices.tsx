import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { friendlyMessage } from "@/lib/api/errors";
import type { SignedInDevice } from "@/lib/api/types";
import { listDevices, signOutDevice, signOutOtherDevices } from "@/lib/auth/api";
import { timeAgo } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

const KEY = ["auth", "devices"];

export default function Devices() {
  const qc = useQueryClient();
  const { shadows } = useTheme();
  const devices = useQuery({ queryKey: KEY, queryFn: listDevices });
  const pull = usePullToRefresh(() => devices.refetch());
  const one = useMutation({ mutationFn: signOutDevice, onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });
  const others = useMutation({ mutationFn: signOutOtherDevices, onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });

  const list = devices.data ?? [];
  const hasOthers = list.some((d) => !d.current);

  function confirmOne(d: SignedInDevice) {
    Alert.alert(`Sign out ${d.device.name}?`, "Anyone using LinkPay on that device will need to sign in again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => one.mutate(d._id) },
    ]);
  }

  function confirmOthers() {
    Alert.alert("Sign out all other devices?", "This phone stays signed in. Every other phone and browser signs out straight away.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out others", style: "destructive", onPress: () => others.mutate() },
    ]);
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-4 pb-12 pt-4"
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[21px] text-muted-foreground">
        Phones and web browsers signed in to your LinkPay account. If you don't recognise one, sign it out and change your password. Signing a phone out also ends its biometric sign-in.
      </Text>

      {(one.error || others.error) && <FormError message={friendlyMessage(one.error ?? others.error)} />}

      {devices.isPending ? (
        <View style={{ boxShadow: shadows.surface }} className="gap-5 rounded-surface bg-card p-4">
          {[0, 1].map((i) => (
            <View key={i} className="flex-row items-center gap-3">
              <View className="h-10 w-10 rounded-[12px] bg-muted" />
              <View className="flex-1 gap-2">
                <View className="h-4 w-2/5 rounded bg-muted" />
                <View className="h-3 w-3/5 rounded bg-muted" />
              </View>
            </View>
          ))}
        </View>
      ) : devices.isError ? (
        <View className="gap-3">
          <FormError message={friendlyMessage(devices.error)} />
          <Button variant="outline" onPress={() => void devices.refetch()}>
            Try again
          </Button>
        </View>
      ) : (
        <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
          {list.map((d, i) => (
            <DeviceRow key={d._id} device={d} divider={i > 0} onSignOut={() => confirmOne(d)} busy={one.isPending && one.variables === d._id} />
          ))}
        </View>
      )}

      {hasOthers && (
        <Button variant="destructive" loading={others.isPending} onPress={confirmOthers}>
          Sign out all other devices
        </Button>
      )}
    </ScrollView>
  );
}

function DeviceRow({ device: d, divider, onSignOut, busy }: { device: SignedInDevice; divider: boolean; onSignOut: () => void; busy: boolean }) {
  const { colors } = useTheme();
  const web = d.device.platform === "web";
  const detail = web
    ? "Web dashboard"
    : [d.device.model !== d.device.name ? d.device.model : undefined, d.device.osVersion && `${d.device.platform === "ios" ? "iOS" : "Android"} ${d.device.osVersion}`]
        .filter(Boolean)
        .join(", ");
  return (
    <View>
      {divider && <View className="ml-[68px] h-px bg-border" />}
      <View className="flex-row items-center gap-3 px-4 py-3.5">
        <View className="h-10 w-10 items-center justify-center rounded-[12px] bg-brand-subtle">
          {web ? (
            <Icon ios="desktopcomputer" android="computer" size={20} color={colors.primary} />
          ) : (
            <Icon ios="iphone" android="smartphone" size={20} color={colors.primary} />
          )}
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="shrink text-[15px] font-medium text-foreground">
              {d.device.name}
            </Text>
            {d.current && (
              <View className="rounded-tag bg-pop-subtle px-1.5 py-0.5">
                <Text className="text-[12px] font-semibold text-success-foreground">This phone</Text>
              </View>
            )}
          </View>
          {!!detail && <Text className="text-[14px] text-muted-foreground">{detail}</Text>}
          <Text className="text-[13px] text-muted-foreground">
            {d.current ? "Active now" : `Last active ${timeAgo(d.lastUsedAt)}`}
            {d.biometricSignIn ? " · Biometric sign-in on" : ""}
          </Text>
        </View>
        {!d.current && (
          <TextButton onPress={onSignOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </TextButton>
        )}
      </View>
    </View>
  );
}
