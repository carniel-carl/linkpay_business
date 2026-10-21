import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormError } from "@/components/ui/form-error";
import { NairaField } from "@/components/ui/naira-field";
import { OptionList, OptionRow } from "@/components/ui/options";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Figure } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import { useInvoice, useInvoiceChange, useSuggestedPayments, type RecordPaymentInput } from "@/lib/api/invoices";
import type { Invoice, PaymentMethod, SuggestedPayment } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, formatNaira } from "@/lib/format";
import { isUnpaid, koboToInput, METHOD_LABELS, todayInLagos } from "@/lib/invoices";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

const MANUAL_METHODS: PaymentMethod[] = ["cash", "pos", "transfer", "cheque", "other"];

/** Links an incoming transfer to the invoice, or records cash, POS and the like by hand. */
export default function RecordPayment() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const invoice = useInvoice(id);
  const inv = invoice.data;

  if (!inv) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {invoice.isError ? (
          <FormError message={friendlyMessage(invoice.error)} />
        ) : (
          <View className="h-40 rounded-surface bg-muted" />
        )}
      </KeyboardAwareScrollView>
    );
  }
  if (!isUnpaid(inv)) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          {inv.status === "draft"
            ? "Send the invoice, or share its link, before recording payments."
            : "This invoice isn't waiting for payment."}
        </Text>
      </KeyboardAwareScrollView>
    );
  }
  return <Form inv={inv} />;
}

function Form({ inv }: { inv: Invoice }) {
  const suggestions = useSuggestedPayments(inv._id, true);
  const change = useInvoiceChange();
  const [chosen, setMode] = useState<"match" | "manual">();
  // Nothing to link: straight to recording by hand, unless the member picked a side.
  const mode = chosen ?? (suggestions.data?.length === 0 || suggestions.isError ? "manual" : "match");
  const [picked, setPicked] = useState<string>();
  const [amount, setAmount] = useState(koboToInput(inv.balanceKobo));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paidAt, setPaidAt] = useState(todayInLagos());
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const kobo = parseNaira(amount);
  const amountError =
    kobo === undefined || kobo < 1
      ? "Enter the amount received."
      : kobo > inv.balanceKobo
        ? `That's more than the ${formatNaira(inv.balanceKobo)} still owed.`
        : undefined;
  const pickError = !picked ? "Choose the transfer that paid this invoice." : undefined;

  function submit() {
    setSubmitted(true);
    let input: RecordPaymentInput;
    if (mode === "match") {
      if (pickError) return;
      input = { transactionId: picked! };
    } else {
      if (amountError) return;
      // Noon in Lagos, so the day never shifts.
      input = {
        amountKobo: kobo!,
        method,
        paidAt: paidAt === todayInLagos() ? undefined : `${paidAt}T12:00:00+01:00`,
        note: note.trim() || undefined,
      };
    }
    change.mutate(
      { kind: "record-payment", id: inv._id, input },
      {
        onSuccess: (next) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
          if (next?.status === "paid") {
            Alert.alert(
              `${inv.number} is paid`,
              inv.customer.email ? "We've emailed the customer a receipt." : undefined,
            );
          } else if (next) {
            Alert.alert("Payment recorded", `${formatNaira(next.balanceKobo)} is still due.`);
          }
        },
      },
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        {formatNaira(inv.balanceKobo)} is still due on {inv.number}.
      </Text>
      <Segmented
        label="How it was paid"
        segments={[
          { key: "match", label: "Transfer in" },
          { key: "manual", label: "Cash, POS, other" },
        ]}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setSubmitted(false);
        }}
      />
      <FormError message={change.error ? friendlyMessage(change.error) : undefined} />

      {mode === "match" ? (
        suggestions.isPending ? (
          <View className="flex-row items-center gap-2 px-1">
            <ActivityIndicator size="small" />
            <Text className="text-[14px] text-muted-foreground">Looking for matching payments…</Text>
          </View>
        ) : !suggestions.data?.length ? (
          <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
            No unlinked payment looks like this one: none for {formatNaira(inv.balanceKobo)} or from {inv.customer.name}
            . If they paid cash or by POS, record it by hand.
          </Text>
        ) : (
          <Suggestions
            items={suggestions.data}
            picked={picked}
            onPick={setPicked}
            error={submitted ? pickError : undefined}
          />
        )
      ) : (
        <View className="gap-5">
          <NairaField
            label="Amount (₦)"
            value={amount}
            onChangeText={setAmount}
            error={submitted ? amountError : undefined}
            hint={kobo && !amountError ? formatNaira(kobo) : undefined}
            style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}
          />
          <OptionList label="Paid by">
            {MANUAL_METHODS.map((m) => (
              <OptionRow
                key={m}
                title={m === "transfer" ? "Transfer to another account" : METHOD_LABELS[m]}
                selected={method === m}
                onPress={() => setMethod(m)}
              />
            ))}
          </OptionList>
          <DateField label="Date received" value={paidAt} onChange={setPaidAt} max={todayInLagos()} />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={(v) => setNote(v.slice(0, 300))}
            placeholder="Receipt number, who took it"
            maxLength={300}
          />
        </View>
      )}

      {(mode === "manual" || !!suggestions.data?.length) && (
        <Button loading={change.isPending} onPress={submit}>
          {mode === "match" ? "Link payment" : "Record payment"}
        </Button>
      )}
    </KeyboardAwareScrollView>
  );
}

/** Payments into the business's accounts that look like they're for this invoice. Pick one. */
function Suggestions({
  items,
  picked,
  onPick,
  error,
}: {
  items: SuggestedPayment[];
  picked?: string;
  onPick: (id: string) => void;
  error?: string;
}) {
  const { shadows } = useTheme();
  return (
    <View className="gap-2">
      <Text className="px-1 text-[14px] text-muted-foreground">
        Payments into your accounts that look like they&apos;re for this invoice.
      </Text>
      <View
        style={{ boxShadow: shadows.surface }}
        className={cn("overflow-hidden rounded-surface bg-card", error && "border-[1.5px] border-destructive")}
      >
        {items.map((s, i) => {
          const selected = picked === s._id;
          return (
            <View key={s._id}>
              {i > 0 && <View className="ml-4 h-px bg-border" />}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`${s.counterparty.name ?? "Unknown payer"}, ${formatNaira(s.amountKobo)}, ${formatDate(s.occurredAt)}`}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onPick(s._id);
                }}
                className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted"
              >
                <View
                  className={cn(
                    "h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px]",
                    selected ? "border-primary" : "border-input",
                  )}
                >
                  {selected && <View className="h-3 w-3 rounded-full bg-primary" />}
                </View>
                <View className="flex-1 gap-0.5">
                  <Text numberOfLines={1} className="text-[15px] font-medium text-foreground">
                    {s.counterparty.name ?? "Unknown payer"}
                  </Text>
                  <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
                    {[formatDate(s.occurredAt), s.counterparty.bankName, s.narration].filter(Boolean).join(" · ")}
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
      {error && <Text className="text-[13px] leading-[18px] text-destructive-foreground">{error}</Text>}
    </View>
  );
}
