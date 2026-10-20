import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { friendlyMessage } from "@/lib/api/errors";
import { useApprovalRule, useSaveApprovalRule } from "@/lib/api/transfers";
import type { ApprovalRule } from "@/lib/api/types";
import { formatNaira } from "@/lib/format";
import { parseNaira } from "@/lib/send-draft";

// Options and copy match web/src/components/transfers/approval-rule-dialog.tsx.
const OPTIONS: { mode: ApprovalRule["mode"]; title: string; description: string }[] = [
  { mode: "never", title: "Only for team members who can't approve", description: "Owners, admins and approvers send straight away." },
  { mode: "above_threshold", title: "From an amount you choose", description: "Transfers at or above it need a second person, whoever sends them." },
  { mode: "always", title: "Every transfer", description: "A second person approves every transfer before it leaves." },
];

/** 50000000 -> "500,000"; keeps kobo only when there are some. */
const koboToInput = (kobo: number) =>
  (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });

/** When transfers need a second person. Reached from Transfers, for members with `transfers.manage`. */
export default function ApprovalRuleScreen() {
  const rule = useApprovalRule();
  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <Text className="px-1 text-[15px] leading-[22px] text-muted-foreground">
        A second person with approval access checks the transfer before money leaves. Nobody can approve their own transfer.
      </Text>
      {rule.data ? (
        <RuleForm rule={rule.data} />
      ) : rule.isError ? (
        <View className="gap-3">
          <FormError message={friendlyMessage(rule.error)} />
          <Button variant="outline" onPress={() => void rule.refetch()}>
            Try again
          </Button>
        </View>
      ) : (
        <View className="h-48 rounded-surface bg-muted" />
      )}
    </KeyboardAwareScrollView>
  );
}

function RuleForm({ rule }: { rule: ApprovalRule }) {
  const save = useSaveApprovalRule();
  const [mode, setMode] = useState(rule.mode);
  const [threshold, setThreshold] = useState(rule.thresholdKobo !== null ? koboToInput(rule.thresholdKobo) : "");
  const [submitted, setSubmitted] = useState(false);

  const kobo = parseNaira(threshold);
  const thresholdError = mode === "above_threshold" && (kobo === undefined || kobo < 100) ? "Enter an amount of at least ₦1." : undefined;

  function submit() {
    setSubmitted(true);
    if (thresholdError) return;
    save.mutate(mode === "above_threshold" ? { mode, thresholdKobo: kobo! } : { mode }, { onSuccess: () => router.back() });
  }

  return (
    <>
      <OptionList label="Transfers need approval">
        {OPTIONS.map((o) => (
          <OptionRow key={o.mode} title={o.title} detail={o.description} selected={mode === o.mode} onPress={() => setMode(o.mode)} />
        ))}
      </OptionList>
      {mode === "above_threshold" && (
        <TextField
          label="Needs approval from (₦)"
          value={threshold}
          onChangeText={(v) => setThreshold(v.replace(/[^\d.,]/g, ""))}
          keyboardType="decimal-pad"
          placeholder="500,000"
          error={submitted ? thresholdError : undefined}
          hint={kobo && !thresholdError ? formatNaira(kobo) : undefined}
          style={{ fontFamily: "BricolageText-SemiBold", fontSize: 20 }}
        />
      )}
      <FormError message={save.error ? friendlyMessage(save.error) : undefined} />
      <Button loading={save.isPending} onPress={submit}>
        Save rule
      </Button>
    </>
  );
}
