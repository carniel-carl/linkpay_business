import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { friendlyMessage } from "@/lib/api/errors";
import { useBanks } from "@/lib/api/transfers";
import { useSendDraft } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** Every bank the payout partner supports, searchable. Choosing one goes back to the form. */
export default function Banks() {
  const { colors } = useTheme();
  const banks = useBanks();
  const { draft, update } = useSendDraft();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = [...(banks.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return query ? all.filter((b) => b.name.toLowerCase().includes(query)) : all;
  }, [banks.data, q]);

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search banks",
            autoCapitalize: "none",
            hideWhenScrolling: false,
            onChangeText: (e) => setQ(e.nativeEvent.text),
          },
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        data={list}
        keyExtractor={(b) => b.uuid}
        contentContainerClassName="pb-12"
        ListHeaderComponent={
          <View className="px-4 pt-2">
            <FocusStatusBar />
            {banks.isError && (
              <View className="gap-3 pb-4">
                <FormError message={friendlyMessage(banks.error)} />
                <Button variant="outline" onPress={() => void banks.refetch()}>
                  Try again
                </Button>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text className="px-5 pt-4 text-[15px] text-muted-foreground">{banks.isPending ? "Loading banks…" : `No bank matches "${q}".`}</Text>
        }
        renderItem={({ item, index }) => (
          <View className="bg-card">
            {index > 0 && <View className="ml-4 h-px bg-border" />}
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: draft.bank?.uuid === item.uuid }}
              onPress={() => {
                update({ bank: item });
                router.back();
              }}
              className="min-h-[52px] flex-row items-center justify-between px-4 active:bg-muted"
            >
              <Text className="flex-1 text-[16px] text-foreground">{item.name}</Text>
              {draft.bank?.uuid === item.uuid && <Icon ios="checkmark" android="check" size={17} color={colors.primary} />}
            </Pressable>
          </View>
        )}
      />
    </>
  );
}
