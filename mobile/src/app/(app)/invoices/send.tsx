import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SuspendedNotice } from "@/components/home/suspended-banner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { friendlyMessage } from "@/lib/api/errors";
import { useInvoice, useInvoiceChange } from "@/lib/api/invoices";
import { formatNaira } from "@/lib/format";
import { formatDay } from "@/lib/invoices";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails the invoice: a link to pay and the PDF attached. Replies go to the business's email. */
export default function SendInvoice() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const invoice = useInvoice(id);
  const inv = invoice.data;
  const change = useInvoiceChange();
  const [to, setTo] = useState<string>();
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

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

  const email = (to ?? inv.customer.email ?? "").trim();
  const emailError = submitted && !EMAIL.test(email) ? "Enter the email address to send it to." : undefined;

  function send() {
    setSubmitted(true);
    if (!EMAIL.test(email)) return;
    change.mutate(
      { kind: "send", id: inv!._id, email: true, to: email, message: message.trim() || undefined },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
          Alert.alert("Invoice sent", `${inv!.number} is on its way to ${email}.`);
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
      <SuspendedNotice />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        {inv.customer.name} gets an email with a link to pay {formatNaira(inv.balanceKobo)} by {formatDay(inv.dueDate)},
        and the PDF attached. Replies come to your business email.
      </Text>
      <FormError message={change.error ? friendlyMessage(change.error) : undefined} />
      <TextField
        label="To"
        value={to ?? inv.customer.email ?? ""}
        onChangeText={setTo}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        error={emailError}
      />
      <TextField
        label="Message (optional)"
        value={message}
        onChangeText={(v) => setMessage(v.slice(0, 1000))}
        multiline
        maxLength={1000}
        placeholder={`Hi ${inv.customer.name.split(" ")[0]}, here's your invoice. Thank you for your business.`}
        hint="Shown above the invoice details."
        style={{ minHeight: 110, paddingTop: 14, textAlignVertical: "top" }}
      />
      <Button write loading={change.isPending} icon={{ ios: "paperplane", android: "send" }} onPress={send}>
        Send invoice
      </Button>
    </KeyboardAwareScrollView>
  );
}
