import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { formatAccountNumber, nairaParts } from "@/lib/format";
import { usePaymentFilters } from "@/lib/payment-filters";
import { shareAccount } from "@/lib/share";

/** A branch account: what a customer needs to pay in, each part copyable, and the way to its payments. */
export default function AccountDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const accounts = useAccounts(true);
  const setFilters = usePaymentFilters((s) => s.setFilters);
  const account = accounts.data?.find((a) => a._id === id);

  if (!account) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {accounts.isPending ? (
          <>
            <View className="h-8 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-48 rounded-surface bg-muted" />
          </>
        ) : (
          <Text className="text-[15px] text-muted-foreground">This account isn't available any more. Go back to Home to see your branches.</Text>
        )}
      </ScrollView>
    );
  }

  const parts = account.balance ? nairaParts(account.balance.availableKobo ?? account.balance.amountKobo) : undefined;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <FocusStatusBar />
      <View className="gap-1 px-1">
        <Text className="text-[13px] font-semibold text-muted-foreground">{account.branch.isHeadOffice ? "Head office" : "Branch"}</Text>
        <Display size={28}>{account.branch.name}</Display>
        <Text className="pt-3 text-[13px] text-muted-foreground">Available balance</Text>
        {parts ? (
          <Text>
            <Figure size={32}>{parts.whole}</Figure>
            <Figure size={18} className="text-muted-foreground">
              {parts.kobo}
            </Figure>
          </Text>
        ) : (
          <Text className="text-[15px] text-muted-foreground">Unavailable right now</Text>
        )}
      </View>

      <DetailList>
        <DetailRow label="Account number" value={formatAccountNumber(account.accountNumber)} copy={account.accountNumber} figure />
        {account.accountName ? <DetailRow label="Account name" value={account.accountName} copy={account.accountName} /> : null}
        {account.bankName ? <DetailRow label="Bank" value={account.bankName} copy={account.bankName} /> : null}
      </DetailList>
      <Text className="-mt-3 px-1 text-[13px] leading-[18px] text-muted-foreground">
        Customers can pay into this account from any Nigerian bank app. Payments show under {account.branch.name}.
      </Text>

      <View className="gap-3">
        <Button icon={{ ios: "square.and.arrow.up", android: "share" }} onPress={() => void shareAccount(account)}>
          Share account details
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            setFilters({ period: "month", branch: account.branch._id, status: undefined, q: undefined });
            router.navigate("/payments");
          }}
        >
          View payments
        </Button>
      </View>
    </ScrollView>
  );
}
