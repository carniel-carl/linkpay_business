import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { openLastRun, PersonRow, RowsCard } from "@/components/payouts/list-parts";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { can, useOverview } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { deletePayoutList, people, usePayoutList, usePayoutListGone, type PayoutListWithItems } from "@/lib/api/payout-lists";
import { formatDate, formatNaira } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/**
 * One payout list: who's on it with what each gets, its default account and when it was last paid. Members who
 * send money pay it (with this time's amounts), edit it or delete it; everyone else sees it read-only.
 */
export default function PayoutListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePayoutList(id);
  const l = list.data;

  if (!l) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {list.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(list.error)} />
            {list.error instanceof ApiError && list.error.code === "PAYOUT_LIST_NOT_FOUND" ? (
              <Button variant="outline" onPress={() => router.back()}>
                Back to payout lists
              </Button>
            ) : (
              <Button variant="outline" onPress={() => void list.refetch()}>
                Try again
              </Button>
            )}
          </View>
        ) : (
          <>
            <View className="h-5 w-28 rounded bg-muted" />
            <View className="h-9 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-32 rounded-surface bg-muted" />
            <View className="h-56 rounded-surface bg-muted" />
          </>
        )}
      </ScrollView>
    );
  }
  return <Detail l={l} refetch={list.refetch} />;
}

function Detail({ l, refetch }: { l: PayoutListWithItems; refetch: () => Promise<unknown> }) {
  const { colors } = useTheme();
  const overview = useOverview();
  const canManage = can(overview.data, "transfers.create");
  const pull = usePullToRefresh(refetch);
  const gone = usePayoutListGone();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const missing = l.items.filter((i) => !i.beneficiary).length;
  const payable = l.items.length - missing;

  const edit = () => router.push({ pathname: "/payments/lists/edit", params: { id: l._id } });

  // Deleting moves no money, so it takes no PIN, but it asks first.
  function confirmDelete() {
    Alert.alert(
      `Delete “${l.title}”?`,
      "The list goes for good. The people on it stay saved as beneficiaries, and payments already made from it stay in Transfers.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete list",
          style: "destructive",
          onPress: () => {
            setDeleting(true);
            setError(undefined);
            deletePayoutList(l._id)
              .then(() => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                gone(l._id);
                router.back();
              })
              .catch((err: unknown) => {
                // Someone else deleted it first: it's gone either way.
                if (err instanceof ApiError && err.code === "PAYOUT_LIST_NOT_FOUND") {
                  gone(l._id);
                  router.back();
                  return;
                }
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                setError(friendlyMessage(err));
              })
              .finally(() => setDeleting(false));
          },
        },
      ],
    );
  }

  return (
    <>
      <Stack.Screen
        options={{ headerRight: canManage ? () => <HeaderButton label="Edit" icon={{ ios: "pencil", android: "edit" }} onPress={edit} /> : undefined }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-4 pb-12 pt-4"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        <FocusStatusBar />
        <View className="gap-1 px-1">
          <Text className="text-[13px] text-muted-foreground">Payout list</Text>
          <Display size={30}>{l.title}</Display>
          <Text className="text-[15px] text-muted-foreground">
            {formatNaira(l.amountKobo)} to {people(l.count)}, before fees
          </Text>
        </View>

        <DetailList>
          <DetailRow label="Pays from" value={l.branch ? l.branch.name : "Choose the account each time"} />
          <DetailRow label="Last paid" value={l.lastRunAt ? formatDate(l.lastRunAt) : "Not paid yet"} />
          {l.createdBy ? <DetailRow label="Saved by" value={`${l.createdBy.name}, ${formatDate(l.createdAt)}`} /> : null}
        </DetailList>

        {l.lastRunAt && (l.lastBatch || l.lastTransfer) && (
          <Pressable
            accessibilityRole="link"
            onPress={() => openLastRun(l)}
            className="-mt-3 min-h-11 flex-row items-center gap-1 self-start px-1 active:opacity-60"
          >
            <Text className="text-[14px] font-semibold text-primary">{l.lastBatch ? "View the last bulk transfer" : "View the last transfer"}</Text>
            <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.primary} />
          </Pressable>
        )}

        {missing > 0 && (
          <View className="rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              {missing === 1 ? "1 person on this list is" : `${missing} people on this list are`} no longer saved as a beneficiary, so they
              can't be paid.{canManage ? " Edit the list to tidy it up." : ""}
            </Text>
          </View>
        )}

        <FormError message={error} />

        {canManage ? (
          <View className="gap-3">
            <Button
              disabled={payable === 0 || deleting}
              icon={{ ios: "paperplane.fill", android: "send" }}
              onPress={() => router.push({ pathname: "/payments/lists/pay", params: { id: l._id } })}
            >
              Pay this list
            </Button>
            <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
              Change an amount or leave someone out just for this payment. Nothing moves until you've checked it and confirmed with your PIN.
            </Text>
          </View>
        ) : (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">
            Your role doesn't include sending money, so you can see this list but not pay or change it. Ask an owner or admin if you need to.
          </Text>
        )}

        <View className="gap-2">
          <Text accessibilityRole="header" className="px-1 text-[13px] font-semibold text-muted-foreground">
            {l.items.length === 1 ? "1 person" : `${l.items.length} people`}
          </Text>
          <RowsCard>
            {l.items.map((i, n) =>
              i.beneficiary ? (
                <PersonRow key={`${n}:${i.beneficiary._id}`} beneficiary={i.beneficiary} amountKobo={i.amountKobo} narration={i.narration} />
              ) : (
                <View key={`${n}:gone`} className="flex-row items-center gap-3 px-4 py-3.5">
                  <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-muted">
                    <Icon ios="person.crop.circle.badge.xmark" android="person_off" size={18} color={colors["muted-foreground"]} />
                  </View>
                  <Text className="flex-1 text-[14px] text-muted-foreground">No longer a saved beneficiary</Text>
                  <Text className="text-[14px] text-muted-foreground">{formatNaira(i.amountKobo)}</Text>
                </View>
              ),
            )}
          </RowsCard>
        </View>

        {canManage && (
          <View className="gap-3">
            <Button variant="outline" onPress={edit} disabled={deleting}>
              Edit list
            </Button>
            <Button variant="destructive" loading={deleting} onPress={confirmDelete}>
              Delete list
            </Button>
          </View>
        )}
      </ScrollView>
    </>
  );
}
