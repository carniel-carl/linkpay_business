import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { BulkRowView } from "@/components/transfers/bulk-row";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage, messageForCode } from "@/lib/api/errors";
import {
  approvalLine,
  BULK_CHECK_SLICE,
  invalidRowsOf,
  previewBulkTransfer,
  resolveAccounts,
  sendBulkTransfer,
} from "@/lib/api/transfers";
import type { BulkPreview, BulkRequest, ResolvedRow } from "@/lib/api/types";
import { MAX_BULK_ROWS } from "@/lib/bulk-csv";
import { apiItems, keyedBody, lookupKey, previewKey, rowProblem, useBulkDraft, type BulkRow, type Checked } from "@/lib/bulk-draft";
import { useBusinessContext } from "@/lib/business-context";
import { formatAccountNumber, formatNaira, formatNairaShort } from "@/lib/format";
import { useTheme } from "@/theme/theme";

/** Defined once, so memoised rows keep the same handler: a row opens to fix or remove, and the review checks it again. */
const openRow = (row: BulkRow) => {
  useBulkDraft.getState().editRow(row.id);
  router.push("/payments/bulk/row");
};

/** A resolve-accounts answer as the draft keeps it, with the row's error in friendly words. */
function checkedOf(item: ResolvedRow | undefined): Checked {
  if (!item) return { error: "We couldn't check this account. Check again." };
  if ("error" in item) return { error: messageForCode(item.code, item.error), code: item.code };
  const { accountNumber, accountName, bankName, kind, label } = item;
  return { data: { accountNumber, accountName, bankName, kind, label } };
}

/**
 * The bank's name check came back empty (NAME_CHECK_UNAVAILABLE): a passing outage, not a wrong account. Every
 * row error arrives through messageForCode, so its copy identifies it. "Check again" asks again: a failed name
 * check isn't kept (the next check re-asks every account without a name), and the preview runs again.
 */
const RETRY_LATER = messageForCode("NAME_CHECK_UNAVAILABLE", "");

/** Why a check or preview stopped. The lookups are limited per member, and the banks can be down. */
function checkError(err: unknown) {
  if (err instanceof ApiError && err.status === 429) return "You've checked a lot of accounts in the last few minutes. Wait a few minutes, then check again.";
  if (err instanceof ApiError && (err.status === 502 || err.code === "PROVIDER_ERROR")) {
    return "We can't reach the banks to check these accounts right now. Try again in a moment.";
  }
  return friendlyMessage(err);
}

/**
 * Check and send a bulk transfer, as on the web: every new account's name from its bank (in slices, so the
 * progress moves), then one preview for the fees, totals, balance and who has to approve. Rows that can't go
 * open to fix or come out; an account the bank now names differently waits until the member has looked. The
 * transaction PIN confirms the send, and the Idempotency-Key follows the rows, so nothing can go twice.
 */
export default function BulkReview() {
  const qc = useQueryClient();
  const businessKey = useBusinessContext((s) => s.businessId ?? "default");
  const { shadows } = useTheme();
  const accounts = useAccounts(true);
  const from = useBulkDraft((s) => s.from);
  const title = useBulkDraft((s) => s.title);
  const rows = useBulkDraft((s) => s.rows);
  const names = useBulkDraft((s) => s.names);
  const renamed = useBulkDraft((s) => s.renamed);
  const serverErrors = useBulkDraft((s) => s.serverErrors);
  const pin = useTransactionPin();
  const [preview, setPreview] = useState<{ key: string; data: BulkPreview } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string>();
  const [sendProblem, setSendProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const key = previewKey(from, rows);

  // Names first (only accounts not checked yet, so fixing a row checks just that one), then the preview.
  useEffect(() => {
    // Stopped when the rows change, a newer check starts, or the screen closes; what it learnt so far is kept.
    let stopped = false;
    const live = () => !stopped;
    const controller = new AbortController();
    void (async () => {
      setProgress(null);
      setPreviewing(false);
      const start = useBulkDraft.getState();
      if (!start.from || !start.rows.length || start.rows.length > MAX_BULK_ROWS || start.rows.some((r) => rowProblem(r))) return;
      setCheckProblem(undefined);

      const pending = new Map<string, { accountNumber: string; bankUuid: string }>();
      for (const r of start.rows) {
        if (!r.beneficiary && r.bank && !start.names[lookupKey(r)]?.data) pending.set(lookupKey(r), { accountNumber: r.accountNumber, bankUuid: r.bank.uuid });
      }
      const queue = [...pending.entries()];
      if (queue.length) {
        setProgress({ done: 0, total: queue.length });
        try {
          for (let i = 0; i < queue.length; i += BULK_CHECK_SLICE) {
            const slice = queue.slice(i, i + BULK_CHECK_SLICE);
            const result = await resolveAccounts(
              slice.map(([, account]) => account),
              controller.signal,
            );
            if (!live()) return;
            useBulkDraft.getState().setNames(Object.fromEntries(slice.map(([k], j) => [k, checkedOf(result.items[j])])));
            setProgress({ done: Math.min(i + slice.length, queue.length), total: queue.length });
          }
        } catch (err) {
          if (live()) setCheckProblem(checkError(err));
          return;
        } finally {
          if (live()) setProgress(null);
        }
      }

      const state = useBulkDraft.getState();
      setPreviewing(true);
      try {
        const data = await previewBulkTransfer(
          { branch: state.from!, title: state.title.trim() || undefined, items: apiItems(state.rows, state.names) },
          controller.signal,
        );
        if (!live()) return;
        // The bank's name moved on since it was checked: show the new one, and hold the row until it's looked at.
        const changes = data.errors.flatMap((e) =>
          e.code === "ACCOUNT_NAME_CHANGED" && e.accountName && state.rows[e.row] ? [{ id: state.rows[e.row].id, accountName: e.accountName }] : [],
        );
        if (changes.length) useBulkDraft.getState().markRenamed(changes);
        setPreview({ key: previewKey(state.from, state.rows), data });
      } catch (err) {
        if (live()) setCheckProblem(checkError(err));
      } finally {
        if (live()) setPreviewing(false);
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [key, attempt]);

  const source = accounts.data?.find((a) => a.branch._id === from);
  if (!from || !rows.length || (!source && !accounts.isPending)) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">Some details are missing. Go back and check the list.</Text>
        <Button variant="outline" onPress={() => router.back()}>
          Back to the list
        </Button>
      </ScrollView>
    );
  }

  const current = preview?.key === key ? preview.data : null;
  const checking = progress !== null || previewing;
  const totalKobo = rows.reduce((s, r) => s + (r.amountKobo ?? 0), 0);
  const people = `${rows.length} ${rows.length === 1 ? "person" : "people"}`;

  // Each row with its name, fee and what stops it going.
  const checked = rows.map((r, i) => {
    const lookup = r.beneficiary ? undefined : names[lookupKey(r)];
    const quoted = current?.rows[i];
    // A changed name isn't a fault to fix: the row shows the new name and waits for the member to look.
    const quotedError = quoted?.error && quoted.code !== "ACCOUNT_NAME_CHANGED" ? messageForCode(quoted.code, quoted.error) : undefined;
    const problem = rowProblem(r) ?? serverErrors[r.id] ?? lookup?.error ?? quotedError;
    const account = lookup?.data;
    return {
      row: r,
      name: r.beneficiary ? r.beneficiary.accountName : account?.accountName,
      note: account?.label ? (account.kind === "internal" ? `Your ${account.label} branch` : `On LinkPay: ${account.label}`) : undefined,
      feeKobo: quoted?.feeKobo,
      problem,
      retryable: problem === RETRY_LATER,
      unchecked: !problem && ((!r.beneficiary && !account) || !quoted),
      was: renamed[lookupKey(r)],
    };
  });
  const failed = checked.filter((c) => c.problem);
  const changed = checked.filter((c) => c.was !== undefined && !c.problem);
  const changedAccounts = new Set(changed.map((c) => lookupKey(c.row))).size;
  const short = current?.blockers.find((b) => b.code === "INSUFFICIENT_BALANCE");
  const blockers = current?.blockers.filter((b) => b.code !== "INSUFFICIENT_BALANCE") ?? [];
  const tooMany = rows.length > MAX_BULK_ROWS;
  const ready =
    !!current && !checking && !tooMany && !failed.length && !changed.length && !short && !blockers.length && !checked.some((c) => c.unchecked);
  const them = failed.length === 1 ? "it" : "them";
  // Rows that only failed because a bank didn't answer the name check: nothing to fix, just try again.
  const waitingOnBanks = failed.length > 0 && failed.every((c) => c.retryable);

  function checkAgain() {
    useBulkDraft.getState().setServerErrors({});
    setSendProblem(undefined);
    setAttempt((a) => a + 1);
  }

  function removeRows(ids: string[], what: string) {
    Alert.alert(what, "Everyone else stays on this bulk transfer.", [
      { text: "Keep them", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          useBulkDraft.getState().removeRows(ids);
          // Nobody left to pay: back to the list to add someone.
          if (!useBulkDraft.getState().rows.length) router.back();
        },
      },
    ]);
  }

  function send() {
    if (!ready || !current) return;
    setSendProblem(undefined);
    const state = useBulkDraft.getState();
    const body: BulkRequest = { branch: state.from!, title: state.title.trim() || undefined, items: apiItems(state.rows, state.names) };
    // Fixed for this confirmation, so a corrected PIN sends exactly the same request under the same key.
    const idempotencyKey = state.keyFor(keyedBody(state.from!, state.rows));
    const sentRows = state.rows;
    const amount = formatNairaShort(current.amountKobo);
    const to = `${sentRows.length} ${sentRows.length === 1 ? "person" : "people"}`;
    void pin.ask({
      title: `Send ${amount}?`,
      subtitle: current.approval.needed
        ? `Enter your transaction PIN to send ${amount} to ${to} for approval.`
        : `Enter your transaction PIN to send ${amount} to ${to}.`,
      pending: "Sending…",
      run: (entered) => sendBulkTransfer(body, idempotencyKey, entered),
      onSuccess: (result) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (result.batch) qc.setQueryData([businessKey, "batch", result.batch._id], result.batch);
        void qc.invalidateQueries({ queryKey: [businessKey] });
        // Back from the batch lands on the Transfers view, where it now shows.
        router.dismissTo({ pathname: "/payments", params: { view: "transfers" } });
        if (result.batch) router.push({ pathname: "/payments/batch/[id]", params: { id: result.batch._id, sent: "1" } });
        else if (result.items[0]) router.push({ pathname: "/payments/transfer/[id]", params: { id: result.items[0]._id, sent: "1" } });
        useBulkDraft.getState().start(state.business);
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const refused = invalidRowsOf(err);
        if (refused.length) {
          // Nothing was created. Changed names wait to be looked at; anything else marks its row.
          const latest = useBulkDraft.getState();
          const isRename = (r: (typeof refused)[number]) => r.code === "ACCOUNT_NAME_CHANGED" && !!r.accountName;
          const renames = refused.filter(isRename).flatMap((r) => (sentRows[r.row] ? [{ id: sentRows[r.row].id, accountName: r.accountName! }] : []));
          const others = refused.filter((r) => !isRename(r));
          if (renames.length) latest.markRenamed(renames);
          if (others.length) {
            latest.setServerErrors(
              Object.fromEntries(others.flatMap((r) => (sentRows[r.row] ? [[sentRows[r.row].id, messageForCode(r.code, r.error)]] : []))),
            );
          }
          // Changed names have their own message above the rows.
          if (!renames.length || others.length) setSendProblem(friendlyMessage(err));
          return;
        }
        if (err instanceof ApiError && err.code === "TIMEOUT") {
          setSendProblem("That took too long, so the bulk transfer may already have gone. Check your transfers before you send it again.");
          return;
        }
        setSendProblem(friendlyMessage(err));
        // The balance or the approvers changed since the preview: work it out again.
        if (err instanceof ApiError && (err.code === "INSUFFICIENT_BALANCE" || err.code === "NO_APPROVER")) setAttempt((a) => a + 1);
      },
    });
  }

  return (
    <>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
        <FocusStatusBar />
        <View className="gap-1 px-1">
          <Text className="text-[13px] text-muted-foreground">{title.trim() ? `Bulk transfer, ${title.trim()}` : "Bulk transfer"}</Text>
          <Display size={36}>{formatNaira(totalKobo)}</Display>
          <Text className="text-[15px] text-muted-foreground">
            to {people}
            {source ? ` from ${source.branch.name}` : ""}
          </Text>
        </View>

        {progress ? (
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: progress.total, now: progress.done }} className="gap-2 px-1">
            <View className="flex-row items-center justify-between gap-2">
              <View className="flex-row items-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="text-[14px] text-muted-foreground">Checking accounts with their banks</Text>
              </View>
              <Text className="text-[14px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                {progress.done} of {progress.total}
              </Text>
            </View>
            <View className="h-1.5 overflow-hidden rounded-full bg-muted">
              <View className="h-full rounded-full bg-primary" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </View>
          </View>
        ) : previewing ? (
          <View className="flex-row items-center gap-2 px-1">
            <ActivityIndicator size="small" />
            <Text className="text-[14px] text-muted-foreground">Working out the fees and who needs to approve…</Text>
          </View>
        ) : null}

        <DetailList>
          <DetailRow label="From" value={source ? `${source.branch.name}, ${formatAccountNumber(source.accountNumber)}` : "…"} />
          <DetailRow label="Amount" value={`${formatNaira(totalKobo)} to ${people}`} />
          <DetailRow
            label="Fees"
            value={
              current
                ? `${formatNaira(current.feeKobo)}${current.stampDutyKobo > 0 ? `, includes ${formatNaira(current.stampDutyKobo)} stamp duty` : ""}`
                : checkProblem
                  ? "Couldn't work out the fees"
                  : "Working out…"
            }
          />
          <DetailRow label="Total from the account" value={current ? formatNaira(current.totalKobo) : "…"} figure={!!current} />
          <DetailRow label="Approval" value={current ? approvalLine(current.approval) : "…"} />
        </DetailList>

        {current?.approval.needed && (
          <View className="rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              {current.approval.levels.length > 1
                ? `Each transfer needs ${current.approval.levels.length} approvals, one after the other. The money is held until the last one.`
                : "This needs a second person to approve it. The money is held until they do."}
              {current.approval.earlierKobo > 0
                ? ` It counts the ${formatNaira(current.approval.earlierKobo)} you've sent from ${current.branch.name} in the last 24 hours.`
                : ""}
            </Text>
          </View>
        )}

        {short && (
          <FormError
            message={`With ${formatNaira(current!.feeKobo)} in fees this needs ${formatNaira(current!.totalKobo)}. ${current!.branch.name} has ${formatNaira(
              current!.availableKobo ?? 0,
            )} available.`}
          />
        )}
        {blockers.map((b) => (
          <FormError key={b.code ?? b.error} message={messageForCode(b.code, b.error)} />
        ))}

        {changed.length > 0 && (
          <View accessibilityRole="alert" className="gap-3 rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              The bank now gives a different name for {changedAccounts === 1 ? "1 account" : `${changedAccounts} accounts`}. Check the highlighted{" "}
              {changed.length === 1 ? "row is" : "rows are"} who you mean to pay before sending.
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pin.busy || checking} onPress={() => useBulkDraft.getState().acceptRenamed()}>
                {changedAccounts === 1 ? "The new name is right" : "The new names are right"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pin.busy || checking}
                onPress={() => removeRows(changed.map((c) => c.row.id), changed.length === 1 ? "Remove this row?" : `Remove these ${changed.length} rows?`)}
              >
                {changed.length === 1 ? "Remove it" : "Remove them"}
              </Button>
            </View>
          </View>
        )}

        {failed.length > 0 && !checking && (
          <View className="gap-3 rounded-field bg-destructive-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-destructive-foreground">
              {waitingOnBanks
                ? `We couldn't check ${failed.length === 1 ? "1 account" : `${failed.length} accounts`} with the bank just now. Check again in a moment, or remove ${them}.`
                : `${failed.length} ${failed.length === 1 ? "row needs" : "rows need"} fixing before anything can be sent. Tap ${them} to fix ${them}, or remove ${them}.`}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pin.busy} onPress={checkAgain}>
                Check again
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pin.busy}
                onPress={() =>
                  removeRows(
                    failed.map((c) => c.row.id),
                    failed.length === 1 ? "Remove the row that needs fixing?" : `Remove the ${failed.length} rows that need fixing?`,
                  )
                }
              >
                {failed.length === 1 ? "Remove it" : "Remove them"}
              </Button>
            </View>
          </View>
        )}

        {checkProblem && (
          <View className="gap-3">
            <FormError message={checkProblem} />
            {!failed.length && (
              <Button variant="outline" onPress={checkAgain}>
                Check again
              </Button>
            )}
          </View>
        )}
        <FormError message={sendProblem} />

        <View className="gap-2">
          <Text className="px-1 text-[13px] font-semibold text-muted-foreground">Each transfer</Text>
          <View style={{ boxShadow: shadows.surface }} className="overflow-hidden rounded-surface bg-card">
            {checked.map((c, i) => (
              <View key={c.row.id}>
                {i > 0 && <View className="ml-[66px] h-px bg-border" />}
                <BulkRowView
                  row={c.row}
                  name={c.name}
                  note={c.unchecked && checking ? "Checking with the bank…" : c.note}
                  feeKobo={c.feeKobo}
                  problem={c.problem}
                  warning={c.was !== undefined ? `The bank's name for this account has changed. You checked “${c.was}”.` : undefined}
                  onPress={openRow}
                />
              </View>
            ))}
          </View>
        </View>

        <View className="gap-3">
          <Button loading={pin.busy} disabled={!ready} onPress={send} icon={{ ios: "paperplane.fill", android: "send" }}>
            {current?.approval.needed
              ? `Send ${rows.length} for approval`
              : `Send ${rows.length} ${rows.length === 1 ? "transfer" : "transfers"}`}
          </Button>
          <Button variant="ghost" disabled={pin.busy} onPress={() => router.back()}>
            Edit the list
          </Button>
        </View>
      </ScrollView>
      {pin.sheet}
    </>
  );
}
