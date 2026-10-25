import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useMoney } from "@/components/savings/pocket-parts";
import { LockProgress, SafelockTile } from "@/components/savings/safelock-parts";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Figure } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import { useRenameSafelock, useSafelock } from "@/lib/api/safelocks";
import type { Safelock } from "@/lib/api/types";
import { formatDateTime, formatNaira } from "@/lib/format";
import { formatDay } from "@/lib/invoices";
import { usePullToRefresh } from "@/lib/query";
import { daysLeftLabel } from "@/lib/savings";
import { useTheme } from "@/theme/theme";

/**
 * One Safelock: amount, time locked so far, its dates and who locked it. Only the title can change; there's
 * deliberately no way to take the money out, add to it or move the date.
 */
export default function SafelockDetail() {
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const lock = useSafelock(id);

  if (!lock.data) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {lock.isError ? (
          <FormError message={friendlyMessage(lock.error)} />
        ) : (
          <>
            <View className="h-5 w-28 rounded bg-muted" />
            <View className="h-10 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-56 rounded-surface bg-muted" />
          </>
        )}
      </KeyboardAwareScrollView>
    );
  }
  return <Detail s={lock.data} justCreated={created === "1"} refetch={lock.refetch} />;
}

function Detail({ s, justCreated, refetch }: { s: Safelock; justCreated: boolean; refetch: () => Promise<unknown> }) {
  const pull = usePullToRefresh(refetch);
  const { colors } = useTheme();
  const money = useMoney();
  const rename = useRenameSafelock();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [error, setError] = useState<string>();
  const released = s.status === "released";
  const branchName = s.branch?.name ?? "the branch";

  function save() {
    const next = title.trim();
    if (!next) return setError("Give the Safelock a name.");
    setError(undefined);
    if (next === s.title) return setRenaming(false);
    rename.mutate(
      { id: s._id, title: next },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setRenaming(false);
        },
      },
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Stack.Screen
        options={{
          title: "Safelock",
          headerRight:
            s.canRename && !renaming
              ? () => (
                  <HeaderButton
                    write
                    label="Rename"
                    icon={{ ios: "pencil", android: "edit" }}
                    onPress={() => {
                      setTitle(s.title);
                      setRenaming(true);
                    }}
                  />
                )
              : undefined,
        }}
      />
      <FocusStatusBar />

      <View className="gap-4 px-1">
        <View className="flex-row items-center gap-3">
          <SafelockTile released={released} size={48} />
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={2} className="text-[17px] font-semibold text-foreground">
              {s.title}
            </Text>
            <View className="flex-row items-center gap-2">
              <View className={released ? "rounded-tag bg-success-subtle px-1.5 py-0.5" : "rounded-tag bg-muted px-1.5 py-0.5"}>
                <Text className={released ? "text-[12px] font-semibold text-success-foreground" : "text-[12px] font-semibold text-muted-foreground"}>
                  {released ? "Unlocked" : "Locked"}
                </Text>
              </View>
              {s.branch && <Text className="text-[13px] text-muted-foreground">{s.branch.name}</Text>}
            </View>
          </View>
        </View>
        <Figure size={36} accessibilityLabel={`${s.title}: ${formatNaira(s.amountKobo)}`}>
          {money(s.amountKobo)}
        </Figure>
        {!released && (
          <View className="gap-2">
            <LockProgress bps={s.progressBps} label="Time locked so far" className="h-2" />
            <View className="flex-row justify-between gap-3">
              <Text className="text-[13px] text-muted-foreground">{daysLeftLabel(s.daysLeft)}</Text>
              <Text className="text-[13px] text-muted-foreground">Unlocks {formatDay(s.unlockOn)}</Text>
            </View>
          </View>
        )}
      </View>

      {justCreated && !released && (
        <View className="rounded-field bg-success-subtle px-4 py-3">
          <Text className="text-[14px] leading-5 text-success-foreground">
            {formatNaira(s.amountKobo)} is locked until {formatDay(s.unlockOn)}.
          </Text>
        </View>
      )}

      {renaming && (
        <View className="gap-3">
          <TextField
            label="Name"
            value={title}
            onChangeText={(v) => {
              setTitle(v.slice(0, 40));
              setError(undefined);
            }}
            maxLength={40}
            autoCapitalize="sentences"
            autoFocus
            error={error ?? (rename.error ? friendlyMessage(rename.error) : undefined)}
            returnKeyType="done"
            onSubmitEditing={save}
          />
          <View className="flex-row gap-3">
            <Button variant="ghost" size="md" className="flex-1" disabled={rename.isPending} onPress={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button write size="md" className="flex-1" loading={rename.isPending} onPress={save}>
              Save name
            </Button>
          </View>
        </View>
      )}

      <DetailList>
        <DetailRow label="Locked on" value={formatDay(s.lockedOn)} />
        <DetailRow
          label={released ? "Unlocked on" : "Unlocks on"}
          value={released ? formatDay(s.unlockOn) : `${formatDay(s.unlockOn)}, at midnight, Lagos time`}
        />
        <DetailRow label="Length" value={`${s.totalDays.toLocaleString("en-NG")} days`} />
        {s.branch ? <DetailRow label="Branch" value={s.branch.name} /> : null}
        <DetailRow label="Locked by" value={s.createdBy?.name ?? "Unknown"} />
        {s.releasedAt ? <DetailRow label="Back in the balance" value={formatDateTime(s.releasedAt)} /> : null}
      </DetailList>

      <View className="flex-row items-start gap-2.5 rounded-field bg-muted px-4 py-3">
        <Icon ios={released ? "lock.open" : "lock"} android={released ? "lock_open" : "lock"} size={16} color={colors["muted-foreground"]} />
        <Text className="flex-1 text-[14px] leading-5 text-muted-foreground">
          {released
            ? `This money went back into ${branchName}'s available balance when it unlocked.`
            : `Nobody can take this money out, add to it or change the date. On ${formatDay(s.unlockOn)} it goes back into ${branchName}'s available balance by itself.`}
        </Text>
      </View>
    </KeyboardAwareScrollView>
  );
}
