import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { HeaderButton } from "@/components/ui/header-button";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { useBeneficiaries } from "@/lib/api/beneficiaries";
import { friendlyMessage } from "@/lib/api/errors";
import type { Beneficiary } from "@/lib/api/types";
import { MAX_BULK_ROWS } from "@/lib/bulk-csv";
import { useBulkDraft } from "@/lib/bulk-draft";
import { cn } from "@/lib/cn";
import { formatAccountNumber } from "@/lib/format";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { usePullToRefresh } from "@/lib/query";
import { useTheme } from "@/theme/theme";

/**
 * Saved beneficiaries to add to a bulk transfer, several at once. They were name-checked when saved, so they
 * need no new name enquiry. Amounts are added on the list (each new row asks for one).
 */
export default function BulkBeneficiaries() {
  const rows = useBulkDraft((s) => s.rows);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const list = useBeneficiaries(q);
  const pull = usePullToRefresh(() => list.refetch());
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [picked, setPicked] = useState<Map<string, Beneficiary>>(() => new Map());
  const added = useMemo(() => new Set(rows.flatMap((r) => (r.beneficiary ? [r.beneficiary._id] : []))), [rows]);
  const room = MAX_BULK_ROWS - rows.length;

  // Search waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim() || undefined), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const toggle = useCallback((b: Beneficiary) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(b._id)) next.delete(b._id);
      else next.set(b._id, b);
      return next;
    });
  }, []);

  const count = picked.size;
  const tooMany = count > room;

  function add() {
    if (!count || tooMany) return;
    useBulkDraft.getState().addRows(
      [...picked.values()].map((b) => ({
        beneficiary: { _id: b._id, accountName: b.accountName, accountNumber: b.accountNumber, bankName: b.bankName, nickname: b.nickname },
        accountNumber: b.accountNumber,
        amountKobo: null,
      })),
    );
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: count > 0 && !tooMany ? () => <HeaderButton label={`Add ${count}`} onPress={add} /> : undefined,
          headerSearchBarOptions: {
            placeholder: "Name, nickname, account or bank",
            autoCapitalize: "none",
            hideWhenScrolling: false,
            onChangeText: (e) => setSearch(e.nativeEvent.text),
            onCancelButtonPress: () => setSearch(""),
          },
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        extraData={picked}
        contentContainerClassName="pb-12"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListHeaderComponent={
          <View className="gap-3 px-4 pb-4 pt-2">
            <FocusStatusBar />
            {/* Always there, so picking the first person doesn't push the list down under the next tap. */}
            {(items.length > 0 || count > 0) && (
              <View className="gap-2">
                <Button onPress={add} disabled={!count || tooMany}>
                  {count ? `Add ${count} ${count === 1 ? "person" : "people"}` : "Pick people to add"}
                </Button>
                {tooMany && (
                  <Text className="text-[13px] leading-[18px] text-destructive-foreground">
                    There's room for {room} more on this bulk transfer ({MAX_BULK_ROWS} at most).
                  </Text>
                )}
              </View>
            )}
            {list.isError && (
              <View className="gap-3">
                <FormError message={friendlyMessage(list.error)} />
                <Button variant="outline" onPress={() => void list.refetch()}>
                  Try again
                </Button>
              </View>
            )}
            {items.length > 0 && (
              <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
                Most recently paid first. You'll add each amount on the list.
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          list.isPending ? (
            <View className="items-center py-6">
              <ActivityIndicator />
            </View>
          ) : list.isError ? undefined : (
            <View className="mx-5 gap-1">
              <Text className="text-[15px] font-semibold text-foreground">{q ? "No matches" : "No saved beneficiaries yet"}</Text>
              <Text className="text-[15px] leading-[22px] text-muted-foreground">
                {q
                  ? `No saved beneficiary matches "${q}".`
                  : "Save people you pay often on the web, under Beneficiaries, and they'll show here. Until then, paste rows from a spreadsheet or add people one at a time."}
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <View className={cn("mx-4 overflow-hidden bg-card", index === 0 && "rounded-t-surface", index === items.length - 1 && "rounded-b-surface")}>
            {index > 0 && <View className="ml-4 h-px bg-border" />}
            <BeneficiaryRow beneficiary={item} selected={picked.has(item._id)} already={added.has(item._id)} onPress={toggle} />
          </View>
        )}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ paddingVertical: 24 }} /> : undefined}
      />
    </>
  );
}

const BeneficiaryRow = memo(function BeneficiaryRow({
  beneficiary: b,
  selected,
  already,
  onPress,
}: {
  beneficiary: Beneficiary;
  selected: boolean;
  already: boolean;
  onPress: (b: Beneficiary) => void;
}) {
  const { colors } = useTheme();
  const checked = selected || already;
  const detail = [b.nickname ? b.accountName : undefined, b.bankName, formatAccountNumber(b.accountNumber)].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: already }}
      accessibilityHint={already ? "Already on this bulk transfer" : undefined}
      disabled={already}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(b);
      }}
      className={cn("min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted", already && "opacity-50")}
    >
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
          {b.nickname ?? b.accountName}
        </Text>
        <Text numberOfLines={1} className="text-[13px] leading-[18px] text-muted-foreground">
          {detail}
        </Text>
        {(already || b.onLinkPay) && (
          <Text className="text-[13px] text-muted-foreground">{already ? "Already on the list" : "On LinkPay"}</Text>
        )}
      </View>
      <View className={cn("h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[1.5px]", checked ? "border-primary bg-primary" : "border-input")}>
        {checked && <Icon ios="checkmark" android="check" size={14} color={colors["primary-foreground"]} />}
      </View>
    </Pressable>
  );
});
