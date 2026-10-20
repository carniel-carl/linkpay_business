import { ScrollView } from "react-native";
import { useBankingGate } from "@/components/home/gate";
import { STATUS_LABELS } from "@/components/payments/status-tag";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSection } from "@/components/ui/list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import type { TransactionStatus } from "@/lib/api/types";
import { usePaymentFilters } from "@/lib/payment-filters";
import { useTheme } from "@/theme/theme";

const STATUSES: TransactionStatus[] = ["success", "pending", "failed", "reversed"];

/** Branch and status pickers, the settings-list shape both platforms use. Choices apply at once. */
export default function PaymentFilters() {
  const { colors } = useTheme();
  const gate = useBankingGate();
  const { filters, setFilters } = usePaymentFilters();
  const branches = gate.state === "ready" ? gate.overview.branches : [];
  const check = (on: boolean) => (on ? <Icon ios="checkmark" android="check" size={17} color={colors.primary} /> : null);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-7 px-4 pb-12 pt-4">
      <FocusStatusBar />
      {branches.length > 1 && (
        <ListSection title="Branch">
          <ListRow
            icon={{ ios: "square.grid.2x2", android: "grid_view" }}
            title="All branches"
            chevron={false}
            selected={!filters.branch}
            onPress={() => setFilters({ branch: undefined })}
            trailing={check(!filters.branch)}
          />
          {branches.map((b) => (
            <ListRow
              key={b._id}
              icon={b.isHeadOffice ? { ios: "building.columns", android: "account_balance" } : { ios: "storefront", android: "storefront" }}
              title={b.name}
              chevron={false}
              selected={filters.branch === b._id}
              onPress={() => setFilters({ branch: b._id })}
              trailing={check(filters.branch === b._id)}
            />
          ))}
        </ListSection>
      )}
      <ListSection title="Status">
        <ListRow
          icon={{ ios: "list.bullet", android: "list" }}
          title="Any status"
          chevron={false}
          selected={!filters.status}
          onPress={() => setFilters({ status: undefined })}
          trailing={check(!filters.status)}
        />
        {STATUSES.map((s) => (
          <ListRow
            key={s}
            icon={STATUS_ICONS[s]}
            title={STATUS_LABELS[s]}
            chevron={false}
            selected={filters.status === s}
            onPress={() => setFilters({ status: s })}
            trailing={check(filters.status === s)}
          />
        ))}
      </ListSection>
    </ScrollView>
  );
}

const STATUS_ICONS: Record<TransactionStatus, Parameters<typeof ListRow>[0]["icon"]> = {
  success: { ios: "checkmark.circle", android: "check_circle" },
  pending: { ios: "clock", android: "schedule" },
  failed: { ios: "xmark.circle", android: "cancel" },
  reversed: { ios: "arrow.uturn.backward.circle", android: "undo" },
};
