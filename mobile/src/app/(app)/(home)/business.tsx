import { router } from "expo-router";
import { ScrollView, Text } from "react-native";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { useMemberships, useOverview } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import type { BusinessStatus } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { usePaymentFilters } from "@/lib/payment-filters";
import { useTheme } from "@/theme/theme";

const STATUS: Partial<Record<BusinessStatus, string>> = {
  draft: "Verification not finished",
  submitted: "Verification in review",
  changes_requested: "Verification needs changes",
  rejected: "Verification not approved",
};

/** Every business the user belongs to, with their role there. */
export default function SwitchBusiness() {
  const { colors } = useTheme();
  const memberships = useMemberships();
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
          {(memberships.data ?? []).map((m) => (
            <ListRow
              key={m.business._id}
              icon={{ ios: "building.2", android: "store" }}
              title={m.business.name}
              detail={[m.roleLabel ?? m.role, STATUS[m.business.status]].filter(Boolean).join(" · ")}
              chevron={false}
              selected={m.business._id === currentId}
              trailing={m.business._id === currentId ? <Icon ios="checkmark" android="check" size={17} color={colors.primary} /> : null}
              onPress={() => {
                if (m.business._id !== currentId) {
                  setBusinessId(m.business._id);
                  // Branch filters belong to the business they were picked in.
                  resetFilters();
                }
                router.back();
              }}
            />
          ))}
        </ListSection>
      )}
      {memberships.isPending && <Text className="px-1 text-[15px] text-muted-foreground">Loading your businesses…</Text>}
    </ScrollView>
  );
}
