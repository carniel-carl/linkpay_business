import { router } from "expo-router";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useTransaction } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { formatAccountNumber, formatDateTime, formatNaira } from "@/lib/format";
import { usePullToRefresh } from "@/lib/query";
import { StatusTag } from "./status-tag";

const STATUS_NOTES = {
  pending: "The bank hasn't confirmed this payment yet. Wait for it to show as successful before you hand over goods.",
  failed: "This payment didn't go through. The payer should check with their bank.",
  reversed: "The bank reversed this payment, so the money went back to the payer.",
} as const;

/** One payment, opened from Home or Payments. */
export function PaymentDetail({ id }: { id: string }) {
  const tx = useTransaction(id);
  const pull = usePullToRefresh(() => tx.refetch());

  if (!tx.data) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-4 pb-12 pt-4">
        <FocusStatusBar />
        {tx.isError ? (
          <>
            <FormError message={friendlyMessage(tx.error)} />
            <Button variant="outline" onPress={() => void tx.refetch()}>
              Try again
            </Button>
          </>
        ) : (
          <View className="gap-3 pt-4">
            <View className="h-5 w-24 rounded bg-muted" />
            <View className="h-10 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-56 rounded-surface bg-muted" />
          </View>
        )}
      </ScrollView>
    );
  }

  const t = tx.data;
  const credit = t.direction === "credit";
  const payer = t.counterparty.name || "Unknown payer";
  // These notes are about money coming in; a payout's status lives on its transfer.
  const note = credit && t.status !== "success" ? STATUS_NOTES[t.status] : undefined;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <FocusStatusBar />
      <View className="gap-2 px-1">
        <StatusTag status={t.status} />
        <Display size={36} accessibilityLabel={`${credit ? "Received" : "Sent"} ${formatNaira(t.amountKobo)}`}>
          {`${credit ? "+" : "\u2212"}${formatNaira(t.amountKobo)}`}
        </Display>
        <Text className="text-[15px] text-muted-foreground">
          {credit ? "From" : "To"} {payer} · {formatDateTime(t.occurredAt)}
        </Text>
      </View>

      {note && (
        <View className="rounded-field bg-warning-subtle px-4 py-3">
          <Text className="text-[14px] leading-5 text-warning-foreground">{note}</Text>
        </View>
      )}

      <DetailList>
        <DetailRow label={credit ? "Payer" : "Recipient"} value={payer} />
        {t.counterparty.bankName ? <DetailRow label="Bank" value={t.counterparty.bankName} /> : null}
        {t.counterparty.accountNumber ? (
          <DetailRow label="Account number" value={formatAccountNumber(t.counterparty.accountNumber)} copy={t.counterparty.accountNumber} figure />
        ) : null}
        {t.narration ? <DetailRow label="Narration" value={t.narration} /> : null}
        {t.reference ? <DetailRow label="Reference" value={t.reference} copy={t.reference} /> : null}
      </DetailList>

      {t.transfer && (
        <Button variant="outline" icon={{ ios: "arrow.up.right", android: "north_east" }} onPress={() => router.push({ pathname: "/payments/transfer/[id]", params: { id: t.transfer! } })}>
          View transfer
        </Button>
      )}

      <DetailList>
        {t.branch ? <DetailRow label="Branch" value={t.branch.name} /> : null}
        {t.account ? <DetailRow label="Paid into" value={`${formatAccountNumber(t.account.accountNumber)}${t.account.bankName ? `, ${t.account.bankName}` : ""}`} /> : null}
        <DetailRow label="Amount" value={formatNaira(t.amountKobo)} />
        <DetailRow label="Fee" value={formatNaira(t.feeKobo)} />
        <DetailRow label={credit ? "You received" : "Total"} value={formatNaira(t.netKobo)} />
      </DetailList>
    </ScrollView>
  );
}
