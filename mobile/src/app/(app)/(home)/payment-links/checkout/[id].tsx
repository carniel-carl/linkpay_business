import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { CheckoutStatusTag } from "@/components/payment-links/parts";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display, Figure } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import { useCheckoutSuggestions, useLinkCheckout, usePaymentLinkChange } from "@/lib/api/payment-links";
import type { LinkCheckout, SuggestedPayment } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime, formatNaira } from "@/lib/format";
import { MATCHED_BY_LABELS, originLabel } from "@/lib/payment-links";
import { useTheme } from "@/theme/theme";

/** One payer's checkout: what they were asked to send, what came in, how it matched, and linking by hand. */
export default function CheckoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const checkout = useLinkCheckout(id);
  const c = checkout.data;

  if (!c) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {checkout.isError ? (
          <View className="gap-3">
            <FormError message={friendlyMessage(checkout.error)} />
            <Button variant="outline" onPress={() => void checkout.refetch()}>
              Try again
            </Button>
          </View>
        ) : (
          <>
            <View className="h-9 w-2/5 rounded bg-muted" />
            <View className="mt-4 h-56 rounded-surface bg-muted" />
          </>
        )}
      </ScrollView>
    );
  }

  const received = c.status === "paid" || c.status === "underpaid";
  const metadata = Object.entries(c.metadata ?? {});
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-3"
      refreshControl={<RefreshControl refreshing={checkout.isRefetching} onRefresh={() => void checkout.refetch()} />}
    >
      <FocusStatusBar />
      <View className="gap-2 px-1">
        <CheckoutStatusTag status={c.status} />
        <Figure size={34}>{formatNaira(received ? (c.paidKobo ?? 0) : c.priceKobo)}</Figure>
        <Text className="text-[15px] text-foreground">
          {c.payer.name}
          {c.link ? <Text className="text-muted-foreground">, {c.link.title}</Text> : null}
        </Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">
          {c.status === "underpaid"
            ? `Part paid: ${formatNaira(c.priceKobo - (c.paidKobo ?? 0))} short of ${formatNaira(c.priceKobo)}.`
            : received
              ? `Received ${c.paidAt ? formatDateTime(c.paidAt) : ""}.`
              : c.status === "expired"
                ? "Their time to pay ran out with nothing matched. A late transfer can still be linked below."
                : `Waiting for their transfer until ${formatDateTime(c.expiresAt)}.`}
        </Text>
      </View>

      <DetailList>
        <DetailRow label="Reference" value={c.reference} copy={c.reference} />
        <DetailRow label="Asked to send" value={`${formatNaira(c.amountKobo)} (the price plus ${c.amountKobo - c.priceKobo} kobo)`} />
        {received && c.matchedBy && (
          <DetailRow label="How it matched" value={`${MATCHED_BY_LABELS[c.matchedBy]}${c.matchedByUser ? ` by ${c.matchedByUser.name}` : ""}`} />
        )}
        <DetailRow label="Started" value={formatDateTime(c.createdAt)} />
        {c.branch && <DetailRow label="Paid into" value={c.branch.name} />}
        <DetailRow label="Started on" value={c.source === "embed" ? `Your website${c.embedOrigin ? ` (${originLabel(c.embedOrigin)})` : ""}` : "The link's page"} />
        {c.clientReference && <DetailRow label="Your order" value={c.clientReference} copy={c.clientReference} />}
      </DetailList>

      <View className="gap-2">
        <Text className="px-1 text-[17px] font-semibold text-foreground">Customer</Text>
        <DetailList>
          <DetailRow label="Email" value={c.payer.email} copy={c.payer.email} />
          {c.payer.phone && <DetailRow label="Phone" value={c.payer.phone} copy={c.payer.phone} />}
          {c.payer.fields.map((f) => (
            <DetailRow key={f.label} label={f.label} value={f.value} />
          ))}
        </DetailList>
      </View>

      {metadata.length > 0 && (
        <View className="gap-2">
          <Text className="px-1 text-[17px] font-semibold text-foreground">Sent by your website</Text>
          <DetailList>
            {metadata.map(([k, v]) => (
              <DetailRow key={k} label={k} value={v} />
            ))}
          </DetailList>
        </View>
      )}

      {c.canMatch && <LinkPayment checkout={c} />}
    </ScrollView>
  );
}

/** Transfers the matcher missed (a round amount, no reference): pick one and link it. */
function LinkPayment({ checkout: c }: { checkout: LinkCheckout }) {
  const { shadows, colors } = useTheme();
  const suggestions = useCheckoutSuggestions(c._id, true);
  const change = usePaymentLinkChange();
  const [picked, setPicked] = useState<string>();
  const chosen = picked ?? suggestions.data?.find((s) => s.exactAmount)?._id;

  function link() {
    if (!chosen) return;
    change.mutate(
      { kind: "match", checkoutId: c._id, transactionId: chosen },
      {
        onSuccess: (next) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert(
            (next as LinkCheckout | undefined)?.status === "paid" ? "Payment linked" : "Linked as a part payment",
            (next as LinkCheckout | undefined)?.status === "paid" ? "We've emailed the customer a receipt." : undefined,
          );
        },
      },
    );
  }

  return (
    <View className="gap-3">
      <View className="gap-1 px-1">
        <Display size={20}>Link a payment</Display>
        <Text className="text-[14px] leading-[20px] text-muted-foreground">
          If {c.payer.name} sent a round amount without the reference, pick their transfer. Only unlinked transfers into{" "}
          {c.branch?.name ?? "this account"} since they started are shown.
        </Text>
      </View>
      <FormError message={change.error ? friendlyMessage(change.error) : suggestions.isError ? friendlyMessage(suggestions.error) : undefined} />
      {suggestions.isPending ? (
        <View className="flex-row items-center gap-2 px-1">
          <ActivityIndicator size="small" />
          <Text className="text-[14px] text-muted-foreground">Looking for matching transfers…</Text>
        </View>
      ) : !suggestions.data?.length ? (
        <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">No transfers that look like this one yet. Pull down to check again.</Text>
      ) : (
        <>
          <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
            {suggestions.data.map((s: SuggestedPayment, i) => {
              const selected = chosen === s._id;
              return (
                <View key={s._id}>
                  {i > 0 && <View className="ml-4 h-px bg-border" />}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`${s.counterparty.name ?? "Unknown sender"}, ${formatNaira(s.amountKobo)}, ${formatDate(s.occurredAt)}`}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setPicked(s._id);
                    }}
                    className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
                  >
                    <View className={cn("h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px]", selected ? "border-primary" : "border-input")}>
                      {selected && <View className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.primary }} />}
                    </View>
                    <View className="flex-1 gap-0.5">
                      <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
                        {s.counterparty.name ?? "Unknown sender"}
                      </Text>
                      <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
                        {[formatDate(s.occurredAt), s.narration].filter(Boolean).join(" · ")}
                      </Text>
                      {s.exactAmount && (
                        <View className="self-start rounded-tag bg-success-subtle px-1.5 py-0.5">
                          <Text className="text-[12px] font-semibold text-success-foreground">Exact amount</Text>
                        </View>
                      )}
                    </View>
                    <Figure size={15}>{formatNaira(s.amountKobo)}</Figure>
                  </Pressable>
                </View>
              );
            })}
          </View>
          <Button loading={change.isPending} disabled={!chosen} onPress={link}>
            Link this payment
          </Button>
        </>
      )}
      <Button variant="ghost" size="md" onPress={() => router.push("/payments")}>
        Open money in
      </Button>
    </View>
  );
}
