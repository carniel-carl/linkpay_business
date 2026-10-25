import { router } from "expo-router";
import { useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { useMemberships, useOverview } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import type { BusinessStatus } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { cn } from "@/lib/cn";
import { usePaymentFilters } from "@/lib/payment-filters";
import { queryClient } from "@/lib/query";
import { membershipRestriction, RESTRICTION_LABELS } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

const STATUS: Partial<Record<BusinessStatus, string>> = {
  draft: "Verification not finished",
  submitted: "Verification in review",
  changes_requested: "Verification needs changes",
  rejected: "Verification not approved",
};

/** Every business the user belongs to, with their role there, and whether compliance has suspended or closed it. */
export default function SwitchBusiness() {
  const { colors } = useTheme();
  const memberships = useMemberships();
  // The list is kept for 5 minutes elsewhere; here a business's state should be current.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["memberships"] });
  }, []);
  const overview = useOverview();
  const setBusinessId = useBusinessContext((s) => s.setBusinessId);
  const resetFilters = usePaymentFilters((s) => s.reset);
  const currentId = overview.data?.business._id;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-5 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {memberships.isError ? (
        <>
          <FormError message={friendlyMessage(memberships.error)} />
          <Button variant="outline" onPress={() => void memberships.refetch()}>
            Try again
          </Button>
        </>
      ) : (
        <ListSection footer="Each business has its own branches, balances and payments. Your role can differ in each.">
          {(memberships.data ?? []).map((m) => {
            const restriction = membershipRestriction(m);
            const label = RESTRICTION_LABELS[restriction];
            return (
              <ListRow
                key={m.business._id}
                icon={{ ios: "building.2", android: "store" }}
                title={m.business.name}
                // A restricted business shows its tag instead of a verification state (a closed one can't be verified now).
                detail={[m.roleLabel ?? m.role, !label && STATUS[m.business.status]].filter(Boolean).join(" · ")}
                chevron={false}
                selected={m.business._id === currentId}
                trailing={
                  <View className="flex-row items-center gap-2">
                    {label && (
                      <View
                        className={cn(
                          "rounded-tag px-1.5 py-0.5",
                          restriction === "banned" ? "bg-destructive-subtle" : "bg-warning-subtle",
                        )}
                      >
                        <Text
                          className={cn(
                            "text-[12px] font-semibold",
                            restriction === "banned" ? "text-destructive-foreground" : "text-warning-foreground",
                          )}
                        >
                          {label}
                        </Text>
                      </View>
                    )}
                    {m.business._id === currentId && (
                      <Icon ios="checkmark" android="check" size={17} color={colors.primary} />
                    )}
                  </View>
                }
                onPress={() => {
                  if (m.business._id !== currentId) {
                    setBusinessId(m.business._id);
                    // Branch filters belong to the business they were picked in.
                    resetFilters();
                  }
                  router.back();
                }}
              />
            );
          })}
        </ListSection>
      )}
      {memberships.isPending && (
        <Text className="px-1 text-[15px] text-muted-foreground">Loading your businesses…</Text>
      )}
    </ScrollView>
  );
}
