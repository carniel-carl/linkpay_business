import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { ConfirmPasscode } from "@/components/security/confirm-passcode";
import { moneyOut, recipientName, TransferStatusTag } from "@/components/transfers/transfer-row";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { friendlyMessage } from "@/lib/api/errors";
import { KIND_LABELS, useTransfer, useTransferAction } from "@/lib/api/transfers";
import type { Transfer } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/store";
import { formatAccountNumber, formatDateTime, formatNaira } from "@/lib/format";
import { unlockWithBiometrics } from "@/lib/security/biometrics";

/** One transfer: where it is, who prepared and decided it, and what the member can do with it now. */
export default function TransferDetail() {
  const { id, sent } = useLocalSearchParams<{ id: string; sent?: string }>();
  const transfer = useTransfer(id);
  const t = transfer.data;

  if (!t) {
    return (
      <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
        <FocusStatusBar />
        {transfer.isError ? (
          <FormError message={friendlyMessage(transfer.error)} />
        ) : (
          <>
            <View className="h-5 w-28 rounded bg-muted" />
            <View className="h-10 w-3/5 rounded bg-muted" />
            <View className="mt-4 h-56 rounded-surface bg-muted" />
          </>
        )}
      </KeyboardAwareScrollView>
    );
  }
  return <Detail t={t} justSent={sent === "1"} refetching={transfer.isRefetching} refetch={() => void transfer.refetch()} />;
}

function Detail({ t, justSent, refetching, refetch }: { t: Transfer; justSent: boolean; refetching: boolean; refetch: () => void }) {
  const action = useTransferAction();
  const biometrics = useAuth((s) => s.biometrics);
  const biometricsChanged = useAuth((s) => s.biometricsChanged);
  const [note, setNote] = useState("");
  const [askPasscode, setAskPasscode] = useState(false);
  const name = recipientName(t);

  function run(kind: "approve" | "reject" | "cancel" | "refresh") {
    action.mutate(
      { id: t._id, action: kind, note: note.trim() || undefined },
      {
        onSuccess: (next) => {
          if (kind === "approve") Alert.alert("Approved", `${formatNaira(next.amountKobo)} is on its way to ${recipientName(next)}.`);
          if (kind === "reject") Alert.alert("Rejected", "The money is available again.");
          if (kind === "cancel") Alert.alert("Transfer cancelled", "The money is available again.");
        },
      },
    );
  }

  // Approving sends money, so it's confirmed like a send: Face ID, or the passcode.
  async function approve() {
    if (biometrics) {
      const result = await unlockWithBiometrics(`Approve ${formatNaira(t.totalKobo)}`);
      if (result === "ok") return run("approve");
      if (result === "changed") biometricsChanged();
    }
    setAskPasscode(true);
  }

  const banner =
    justSent &&
    (t.status === "pending_approval"
      ? "Sent for approval. The money is held on the account until someone approves or rejects it."
      : t.status === "processing"
        ? "On its way. Most transfers arrive within minutes; this page updates by itself."
        : t.status === "success"
          ? `Sent. ${name} has been paid.`
          : undefined);

  return (
    <>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-4 pb-12 pt-4"
        refreshControl={<RefreshControl refreshing={refetching} onRefresh={refetch} />}
      >
        <FocusStatusBar />
        <View className="gap-2 px-1">
          <TransferStatusTag status={t.status} />
          <Display size={36} accessibilityLabel={`${formatNaira(t.amountKobo)} out`}>
            {moneyOut(t.amountKobo)}
          </Display>
          <Text className="text-[15px] text-muted-foreground">
            to {name} · {formatDateTime(t.createdAt)}
          </Text>
        </View>

        {banner && (
          <View className="rounded-field bg-success-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-success-foreground">{banner}</Text>
          </View>
        )}
        {t.status === "failed" && (
          <View className="rounded-field bg-destructive-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-destructive-foreground">
              {(t.failureReason ?? "The bank couldn't complete this transfer").replace(/\.$/, "")}. Any money taken has been returned.
            </Text>
          </View>
        )}
        {t.decision && (t.status === "rejected" || t.decision.note) && (
          <View className="rounded-field bg-muted px-4 py-3">
            <Text className="text-[13px] text-muted-foreground">
              {t.status === "rejected" ? "Rejected" : "Approved"} by {t.decision.by?.name ?? "a team member"} · {formatDateTime(t.decision.at)}
            </Text>
            {t.decision.note && <Text className="pt-0.5 text-[15px] leading-[21px] text-foreground">{t.decision.note}</Text>}
          </View>
        )}

        <DetailList>
          <DetailRow label="To" value={name} />
          <DetailRow label="Account" value={`${formatAccountNumber(t.recipient.accountNumber)}${t.recipient.bankName ? `, ${t.recipient.bankName}` : ""}`} copy={t.recipient.accountNumber} />
          <DetailRow label="Type" value={KIND_LABELS[t.kind]} />
          {t.branch ? <DetailRow label="From" value={t.branch.name} /> : null}
          {t.narration ? <DetailRow label="Narration" value={t.narration} /> : null}
          <DetailRow label="Reference" value={t.reference} copy={t.reference} />
          {t.createdBy ? <DetailRow label="Prepared by" value={t.createdBy.name} /> : null}
          {t.decision && t.status !== "rejected" && t.status !== "cancelled" ? (
            <DetailRow label="Approved by" value={`${t.decision.by?.name ?? "A team member"}, ${formatDateTime(t.decision.at)}`} />
          ) : null}
          {t.completedAt ? <DetailRow label="Completed" value={formatDateTime(t.completedAt)} /> : null}
        </DetailList>

        <DetailList>
          <DetailRow label="Amount" value={formatNaira(t.amountKobo)} />
          <DetailRow label="Fee" value={`${formatNaira(t.feeKobo)}${t.stampDutyKobo > 0 ? `, includes ${formatNaira(t.stampDutyKobo)} stamp duty` : ""}`} />
          <DetailRow label="Total from the account" value={formatNaira(t.totalKobo)} />
        </DetailList>

        <FormError message={action.error ? friendlyMessage(action.error) : undefined} />

        {t.canApprove && (
          <View className="gap-3">
            <TextField label="Note (optional)" value={note} onChangeText={(v) => setNote(v.slice(0, 300))} hint="The person who prepared it sees this." maxLength={300} />
            <Button loading={action.isPending && action.variables?.action === "approve"} disabled={action.isPending} onPress={() => void approve()}>
              Approve and send
            </Button>
            <Button
              variant="destructive"
              loading={action.isPending && action.variables?.action === "reject"}
              disabled={action.isPending}
              onPress={() =>
                Alert.alert("Reject this transfer?", `${formatNaira(t.amountKobo)} to ${name} won't be sent, and the money is available again.`, [
                  { text: "Keep it", style: "cancel" },
                  { text: "Reject", style: "destructive", onPress: () => run("reject") },
                ])
              }
            >
              Reject
            </Button>
          </View>
        )}
        {t.canCancel && (
          <Button
            variant="destructive"
            loading={action.isPending && action.variables?.action === "cancel"}
            onPress={() =>
              Alert.alert("Cancel this transfer?", "It won't be sent, and the money is available again.", [
                { text: "Keep it", style: "cancel" },
                { text: "Cancel transfer", style: "destructive", onPress: () => run("cancel") },
              ])
            }
          >
            Cancel transfer
          </Button>
        )}
        {t.status === "pending_approval" && !t.canApprove && !t.canCancel && (
          <Text className="px-1 text-[14px] leading-5 text-muted-foreground">Waiting for someone with approval rights to approve or reject it.</Text>
        )}
        {t.status === "processing" && (
          <Button variant="outline" loading={action.isPending && action.variables?.action === "refresh"} onPress={() => run("refresh")}>
            Check status now
          </Button>
        )}
      </KeyboardAwareScrollView>
      {askPasscode && (
        <ConfirmPasscode
          title={`Approve ${formatNaira(t.totalKobo)}?`}
          subtitle={`Enter your passcode to send it to ${name}.`}
          onConfirmed={() => {
            setAskPasscode(false);
            run("approve");
          }}
          onCancel={() => setAskPasscode(false)}
        />
      )}
    </>
  );
}
