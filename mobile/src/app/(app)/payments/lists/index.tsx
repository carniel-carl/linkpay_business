import { router, Stack } from "expo-router";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { ListCard, ListCardSkeleton } from "@/components/payouts/list-parts";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { can } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { MAX_LISTS, usePayoutLists, type PayoutList } from "@/lib/api/payout-lists";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised cards keep the same handlers. */
const openList = (l: PayoutList) => router.push({ pathname: "/payments/lists/[id]", params: { id: l._id } });
const payList = (l: PayoutList) => router.push({ pathname: "/payments/lists/pay", params: { id: l._id } });
const newList = () => router.push("/payments/lists/edit");

/**
 * Payout lists, as on the web: saved bulk payouts like "Monthly salaries", each with its default account, how many
 * people, the total before fees and when it was last paid (opening that payment). Paying one makes an ordinary
 * bulk transfer, with the approval rules. Members who can't send money see the lists read-only.
 */
export default function PayoutLists() {
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const lists = usePayoutLists(ready);
  const pull = usePullToRefresh(() => lists.refetch());

  if (!ready) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-12 pt-4">
        <FocusStatusBar />
        {gate.state === "loading" ? <ActivityIndicator /> : <GateMessage gate={gate} />}
      </ScrollView>
    );
  }

  const canManage = can(gate.overview, "transfers.create");
  const items = lists.data ?? [];
  const full = items.length >= MAX_LISTS;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: canManage && !full && items.length > 0 ? () => <HeaderButton label="New" icon={{ ios: "plus", android: "add" }} onPress={newList} /> : undefined,
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        ItemSeparatorComponent={Gap}
        ListHeaderComponent={
          <View className="gap-4 px-4 pb-4 pt-2">
            <FocusStatusBar />
            {items.length > 0 && (
              <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
                {canManage
                  ? "The people you pay often, with what each one gets. Pay everyone on a list at once; each payment is a bulk transfer, with your approval rules."
                  : "The people your business pays often, with what each one gets. Each payment from a list is a bulk transfer, with your approval rules."}
              </Text>
            )}
            {full && canManage && (
              <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
                You have {MAX_LISTS} payout lists, the most a business can have. Delete one to add another.
              </Text>
            )}
            {lists.isError && (
              <View className="gap-3">
                <FormError message={friendlyMessage(lists.error)} />
                <Button variant="outline" onPress={() => void lists.refetch()}>
                  Try again
                </Button>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => <ListCard list={item} canPay={canManage} onPress={openList} onPay={payList} />}
        ListEmptyComponent={
          lists.isPending ? (
            <View className="gap-3">
              <ListCardSkeleton />
              <ListCardSkeleton />
            </View>
          ) : lists.isError ? undefined : (
            <FirstList canManage={canManage} />
          )
        }
      />
    </>
  );
}

const Gap = () => <View className="h-3" />;

function FirstList({ canManage }: { canManage: boolean }) {
  const { colors } = useTheme();
  return (
    <View className="mx-5 items-start gap-3">
      <View className="h-12 w-12 items-center justify-center rounded-[14px] bg-pop-subtle">
        <Icon ios="list.bullet.rectangle" android="checklist" size={22} color={colors["success-foreground"]} />
      </View>
      <Display size={22}>Pay the same people again in a few taps</Display>
      <Text className="text-[15px] leading-[22px] text-muted-foreground">
        {canManage
          ? "Save the people you pay often, like monthly salaries or regular suppliers, with what each one gets. Then pay the whole list at once, changing amounts when you need to."
          : "Lists of people your business pays often, like monthly salaries, show here once someone who sends money saves one."}
      </Text>
      {canManage && (
        <Button size="md" icon={{ ios: "plus", android: "add" }} onPress={newList}>
          New payout list
        </Button>
      )}
    </View>
  );
}
