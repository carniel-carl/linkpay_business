import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { friendlyMessage } from "@/lib/api/errors";
import { useCustomers } from "@/lib/api/invoices";
import { cn } from "@/lib/cn";
import { useCustomerPick } from "@/lib/customer-pick";
import { keyById, LIST_PERFORMANCE } from "@/lib/list";
import { initials } from "@/lib/format";
import { useTheme } from "@/theme/theme";

/** The business's saved customers, searchable. Choosing one, or "New customer", goes back to the invoice. */
export default function Customers() {
  const { colors, shadows } = useTheme();
  const { selected } = useLocalSearchParams<{ selected?: string }>();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const customers = useCustomers(q);
  const items = customers.data?.items ?? [];

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim() || undefined), 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Name, email or phone",
            autoCapitalize: "none",
            hideWhenScrolling: false,
            onChangeText: (e) => setSearch(e.nativeEvent.text),
          },
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        data={items}
        keyExtractor={keyById}
        {...LIST_PERFORMANCE}
        contentContainerClassName="pb-12"
        ListHeaderComponent={
          <View className="gap-4 px-4 pb-4 pt-2">
            <FocusStatusBar />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                useCustomerPick.getState().set("new");
                router.back();
              }}
              style={{ boxShadow: shadows.surface }}
              className="min-h-14 flex-row items-center gap-3 rounded-surface bg-card px-4 py-3 active:bg-muted"
            >
              <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-brand-subtle">
                <Icon ios="person.badge.plus" android="person_add" size={19} color={colors.primary} />
              </View>
              <Text className="flex-1 text-[15px] font-medium text-primary">New customer</Text>
            </Pressable>
            {customers.isError && (
              <View className="gap-3">
                <FormError message={friendlyMessage(customers.error)} />
                <Button variant="outline" onPress={() => void customers.refetch()}>
                  Try again
                </Button>
              </View>
            )}
            {items.length > 0 && (
              <Text className="px-1 text-[14px] font-medium text-muted-foreground">Saved customers</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          customers.isPending ? (
            <Text className="px-5 text-[15px] text-muted-foreground">Loading customers…</Text>
          ) : customers.isError ? undefined : (
            <Text className="px-5 text-[15px] leading-[22px] text-muted-foreground">
              {q
                ? `No saved customer matches "${q}".`
                : "No saved customers yet. New customers are saved for next time when you create an invoice."}
            </Text>
          )
        }
        renderItem={({ item, index }) => (
          <View
            className={cn(
              "mx-4 overflow-hidden bg-card",
              index === 0 && "rounded-t-surface",
              index === items.length - 1 && "rounded-b-surface",
            )}
          >
            {index > 0 && <View className="ml-[66px] h-px bg-border" />}
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected === item._id }}
              onPress={() => {
                useCustomerPick.getState().set(item);
                router.back();
              }}
              className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
            >
              <View className="h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-brand-subtle">
                <Text maxFontSizeMultiplier={1.2} className="text-[14px] font-semibold text-primary">
                  {initials(item.name) || "?"}
                </Text>
              </View>
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
                  {item.name}
                </Text>
                {(item.email || item.phone) && (
                  <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
                    {[item.email, item.phone].filter(Boolean).join(" · ")}
                  </Text>
                )}
              </View>
              {selected === item._id && <Icon ios="checkmark" android="check" size={17} color={colors.primary} />}
            </Pressable>
          </View>
        )}
      />
    </>
  );
}
