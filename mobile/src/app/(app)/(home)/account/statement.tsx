import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormError, Notice } from "@/components/ui/form-error";
import { OptionList, OptionRow } from "@/components/ui/options";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { friendlyMessage } from "@/lib/api/errors";
import { openStatement } from "@/lib/api/statements";
import type { Account, StatementFormat } from "@/lib/api/types";
import { formatAccountNumber } from "@/lib/format";
import { todayInLagos } from "@/lib/invoices";
import { periodError, presetRange, rangeLabel, STATEMENT_PERIOD_LABELS, STATEMENT_PERIODS, type StatementPeriod } from "@/lib/statements";

const FORMAT_HINTS: Record<StatementFormat, string> = {
  pdf: "A formatted statement to read, print or send to your accountant, up to 5,000 transactions. It opens in your phone's viewer, where you can share or save it.",
  csv: "The balances, then one row per transaction, for Excel, Google Sheets or accounting software, up to 20,000 transactions. It opens in a spreadsheet app, or you can share or save it.",
};

/** A branch account's statement: pick the period and the format, then it opens like an invoice PDF does. */
export default function StatementScreen() {
  const { branch } = useLocalSearchParams<{ branch?: string }>();
  const gate = useBankingGate();
  const accounts = useAccounts(gate.state === "ready");
  const account = accounts.data?.find((a) => a.branch._id === branch);

  if (gate.state === "ready" && account) return <Form account={account} />;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-4 pt-6">
      <Stack.Screen options={{ title: "Statement" }} />
      <FocusStatusBar />
      {gate.state === "loading" || (gate.state === "ready" && accounts.isPending) ? (
        <>
          <View className="h-8 w-3/5 rounded bg-muted" />
          <View className="mt-4 h-48 rounded-surface bg-muted" />
        </>
      ) : gate.state !== "ready" ? (
        <GateMessage gate={gate} />
      ) : accounts.isError ? (
        <View className="gap-3">
          <FormError message={friendlyMessage(accounts.error)} />
          <Button variant="outline" onPress={() => void accounts.refetch()}>
            Try again
          </Button>
        </View>
      ) : (
        <Text className="text-[15px] text-muted-foreground">This account isn&apos;t available any more. Go back to Home to see your branches.</Text>
      )}
    </ScrollView>
  );
}

function Form({ account }: { account: Account }) {
  const today = todayInLagos();
  const [period, setPeriod] = useState<StatementPeriod>("this_month");
  // Custom dates start from this month, so only the ends need changing.
  const [custom, setCustom] = useState(() => presetRange("this_month", today));
  const [format, setFormat] = useState<StatementFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const range = period === "custom" ? custom : presetRange(period, today);
  const problem = period === "custom" ? periodError(range.from, range.to, today) : undefined;

  async function download() {
    if (problem) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = await openStatement({ branch: account.branch._id, from: range.from, to: range.to, format });
      if (outcome === "saved") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setNotice("Saved to the folder you chose.");
      }
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
      <Stack.Screen options={{ title: "Statement" }} />
      <FocusStatusBar />
      <View className="gap-1 px-1">
        <Text className="text-[13px] font-semibold text-muted-foreground">Statement</Text>
        <Display size={28}>{account.branch.name}</Display>
        <Text className="text-[15px] text-muted-foreground">
          {[formatAccountNumber(account.accountNumber), account.bankName].filter(Boolean).join(" · ")}
        </Text>
      </View>

      <OptionList label="Period">
        {STATEMENT_PERIODS.map((p) => (
          <OptionRow
            key={p}
            title={STATEMENT_PERIOD_LABELS[p]}
            detail={p === "custom" ? (period === "custom" ? rangeLabel(custom.from, custom.to) : "Up to 366 days") : rangeLabel(presetRange(p, today).from, presetRange(p, today).to)}
            selected={period === p}
            disabled={busy}
            onPress={() => {
              setPeriod(p);
              setError(undefined);
            }}
          />
        ))}
      </OptionList>

      {period === "custom" && (
        <View className="gap-4">
          <DateField
            label="From"
            value={custom.from}
            max={custom.to < today ? custom.to : today}
            disabled={busy}
            onChange={(from) => setCustom((c) => ({ ...c, from }))}
          />
          <DateField
            label="To"
            value={custom.to}
            min={custom.from}
            max={today}
            disabled={busy}
            error={problem}
            hint="Up to 366 days, ending today or earlier."
            onChange={(to) => setCustom((c) => ({ ...c, to }))}
          />
        </View>
      )}

      <View className="gap-2">
        <Text className="text-[14px] font-medium text-foreground">Format</Text>
        <Segmented
          label="Format"
          segments={[
            { key: "pdf", label: "PDF" },
            { key: "csv", label: "CSV" },
          ]}
          value={format}
          onChange={setFormat}
        />
        <Text className="text-[13px] leading-[18px] text-muted-foreground">{FORMAT_HINTS[format]}</Text>
      </View>

      <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
        Every completed payment into and out of this account, with totals, in Lagos time. Opening and closing balances appear
        where the bank reported them, from the first day they were recorded.
      </Text>

      <FormError message={error} />
      {notice ? <Notice message={notice} tone="success" /> : null}

      <Button
        loading={busy}
        disabled={!!problem}
        icon={{ ios: "arrow.down.doc", android: "download" }}
        onPress={() => void download()}
      >
        {busy ? "Preparing…" : `Download ${format.toUpperCase()}`}
      </Button>
    </ScrollView>
  );
}
