import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { PersonRow, RowsCard } from "@/components/payouts/list-parts";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage, messageForCode } from "@/lib/api/errors";
import { people, runPayoutList, usePayoutListGone } from "@/lib/api/payout-lists";
import { approvalLine, invalidRowsOf, previewBulkTransfer } from "@/lib/api/transfers";
import type { BulkPreview } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { formatAccountNumber, formatNaira, formatNairaShort } from "@/lib/format";
import { runChanged, runItems, runKeyBody, runKobo, runPreviewKey, usePayoutRun } from "@/lib/payout-list-draft";

/**
 * The bank's name check didn't answer (NAME_CHECK_UNAVAILABLE): a passing outage, not a wrong account, so the
 * row is worth checking again rather than leaving out. Every row error arrives through messageForCode.
 */
const RETRY_LATER = messageForCode("NAME_CHECK_UNAVAILABLE", "");

/** Why the preview stopped. The banks can be down. */
function checkError(err: unknown) {
  if (err instanceof ApiError && (err.status === 502 || err.code === "PROVIDER_ERROR")) {
    return "We can't reach the banks to work this out right now. Try again in a moment.";
  }
  return friendlyMessage(err);
}

/**
 * Check and pay a payout list, as on the web: the bulk transfer preview with this time's rows works out every
 * fee, the total, the balance and who has to approve, and what would stop it (blockers, rows that can't be paid).
 * A name the bank now gives differently waits until the member has looked; rows that can't be paid can be left
 * out this time. The transaction PIN confirms the run, and its Idempotency-Key follows what's paid, so nothing can
 * go twice. The result opens on the bulk transfer, or the transfer when it paid one person.
 */
export default function ListReview() {
  const qc = useQueryClient();
  const businessKey = useBusinessContext((s) => s.businessId ?? "default");
  const accounts = useAccounts(true);
  const gone = usePayoutListGone();
  const list = usePayoutRun((s) => s.list);
  const rows = usePayoutRun((s) => s.rows);
  const listGone = usePayoutRun((s) => s.gone);
  const from = usePayoutRun((s) => s.from);
  const saveItems = usePayoutRun((s) => s.saveItems);
  const renamed = usePayoutRun((s) => s.renamed);
  const serverErrors = usePayoutRun((s) => s.serverErrors);
  const pin = useTransactionPin();
  const [preview, setPreview] = useState<{ key: string; data: BulkPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string>();
  const [sendProblem, setSendProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const key = runPreviewKey(from, rows);

  // Always fresh on opening: the balance, fees and approvers may have changed since the last look.
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    void (async () => {
      const s = usePayoutRun.getState();
      const items = runItems(s.rows);
      if (!s.from || !s.list || !items.length) return;
      setPreviewing(true);
      setCheckProblem(undefined);
      try {
        const data = await previewBulkTransfer({ branch: s.from, items }, controller.signal);
        if (stopped) return;
        // A saved name that no longer matches: show the new one, and hold the row until it's been looked at.
        const sent = s.rows.filter((r) => r.include);
        const changes = data.errors.flatMap((e) =>
          e.code === "ACCOUNT_NAME_CHANGED" && e.accountName && sent[e.row] ? [{ key: sent[e.row].key, accountName: e.accountName }] : [],
        );
        if (changes.length) usePayoutRun.getState().markRenamed(changes);
        setPreview({ key: runPreviewKey(s.from, s.rows), data });
      } catch (err) {
        if (!stopped) setCheckProblem(checkError(err));
      } finally {
        if (!stopped) setPreviewing(false);
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [key, attempt]);

  const included = rows.filter((r) => r.include);
  const source = accounts.data?.find((a) => a.branch._id === from);
  if (!list || !from || !included.length || (!source && !accounts.isPending)) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pt-6">
        <FocusStatusBar />
        <Text className="text-[15px] text-muted-foreground">Some details are missing. Go back and check the payment.</Text>
        <Button variant="outline" onPress={() => router.back()}>
          Back to the list
        </Button>
      </ScrollView>
    );
  }

  const current = preview?.key === key ? preview.data : null;
  const amountKobo = included.reduce((s, r) => s + (runKobo(r) ?? 0), 0);
  const changedList = runChanged(rows, listGone);
  const checked = included.map((r, i) => {
    const quoted = current?.rows[i];
    // A changed name isn't a fault to fix: the row shows the new name and waits for the member to look.
    const quotedError = quoted?.error && quoted.code !== "ACCOUNT_NAME_CHANGED" ? messageForCode(quoted.code, quoted.error) : undefined;
    const problem = serverErrors[r.key] ?? quotedError;
    return { row: r, kobo: runKobo(r), feeKobo: quoted?.feeKobo, problem, retryable: problem === RETRY_LATER, unchecked: !problem && !quoted, was: renamed[r.key] };
  });
  const failed = checked.filter((c) => c.problem);
  const changedNames = checked.filter((c) => c.was !== undefined && !c.problem);
  const short = current?.blockers.find((b) => b.code === "INSUFFICIENT_BALANCE");
  const blockers = current?.blockers.filter((b) => b.code !== "INSUFFICIENT_BALANCE") ?? [];
  const ready = !!current && !previewing && !failed.length && !changedNames.length && !short && !blockers.length && !checked.some((c) => c.unchecked);
  const them = failed.length === 1 ? "it" : "them";
  const waitingOnBanks = failed.length > 0 && failed.every((c) => c.retryable);
  const to = people(included.length);

  function checkAgain() {
    usePayoutRun.getState().setServerErrors({});
    setSendProblem(undefined);
    setAttempt((a) => a + 1);
  }

  /** Leaves these out of this payment (they stay on the list), and works it out again. */
  function leaveOut(keys: string[]) {
    usePayoutRun.getState().leaveOut(keys);
    setSendProblem(undefined);
    if (!usePayoutRun.getState().rows.some((r) => r.include)) router.back();
  }

  function send() {
    if (!ready || !current) return;
    setSendProblem(undefined);
    const s = usePayoutRun.getState();
    const listId = s.list!._id;
    const sentRows = s.rows.filter((r) => r.include);
    const body = { branch: s.from!, items: runItems(s.rows), saveItems: s.saveItems && runChanged(s.rows, s.gone) ? true : undefined };
    // Fixed for this confirmation, so a corrected PIN sends exactly the same request under the same key.
    const idempotencyKey = s.keyFor(runKeyBody(listId, s.from!, s.rows));
    const amount = formatNairaShort(current.amountKobo);
    const branchName = source?.branch.name ?? current.branch.name;
    void pin.ask({
      title: current.approval.needed ? `Send ${amount} for approval?` : `Pay ${amount}?`,
      subtitle: current.approval.needed
        ? `Enter your transaction PIN to send ${amount} to ${to} from ${branchName} for approval.`
        : `Enter your transaction PIN to pay ${amount} to ${to} from ${branchName}.`,
      pending: "Sending…",
      run: (entered) => runPayoutList(listId, body, idempotencyKey, entered),
      onSuccess: (result) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (result.batch) qc.setQueryData([businessKey, "batch", result.batch._id], result.batch);
        void qc.invalidateQueries({ queryKey: [businessKey] });
        // Back from the payment lands on the list, now showing it as last paid.
        router.dismissTo("/payments/lists");
        router.push({ pathname: "/payments/lists/[id]", params: { id: listId } });
        if (result.batch) router.push({ pathname: "/payments/batch/[id]", params: { id: result.batch._id, sent: "1" } });
        else if (result.items[0]) router.push({ pathname: "/payments/transfer/[id]", params: { id: result.items[0]._id, sent: "1" } });
        // The next payment starts from the list as it is now, under new keys.
        usePayoutRun.getState().finish();
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const refused = invalidRowsOf(err);
        if (refused.length) {
          // Nothing was created. Changed names wait to be looked at; anything else marks its row.
          const latest = usePayoutRun.getState();
          const isRename = (r: (typeof refused)[number]) => r.code === "ACCOUNT_NAME_CHANGED" && !!r.accountName;
          const renames = refused.filter(isRename).flatMap((r) => (sentRows[r.row] ? [{ key: sentRows[r.row].key, accountName: r.accountName! }] : []));
          const others = refused.filter((r) => !isRename(r));
          if (renames.length) latest.markRenamed(renames);
          if (others.length) {
            latest.setServerErrors(Object.fromEntries(others.flatMap((r) => (sentRows[r.row] ? [[sentRows[r.row].key, messageForCode(r.code, r.error)]] : []))));
          }
          if (!renames.length || others.length) setSendProblem(friendlyMessage(err));
          return;
        }
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === "TIMEOUT") {
          void qc.invalidateQueries({ queryKey: [businessKey] });
          setSendProblem("That took too long, so the payment may already have gone. Check Transfers before you pay this list again.");
          return;
        }
        if (code === "IDEMPOTENCY_KEY_REUSED") {
          // The key was used for other details: say so, and let a deliberate retry be a new request.
          usePayoutRun.getState().freshKeys();
          setSendProblem("These payment details changed after they were first sent. Check Transfers to see whether it went before you pay again.");
          return;
        }
        if (code === "PAYOUT_LIST_NOT_FOUND") {
          gone(listId);
          Alert.alert("This list is gone", friendlyMessage(err), [
            {
              text: "OK",
              onPress: () => {
                router.dismissTo("/payments/lists");
                usePayoutRun.getState().finish();
              },
            },
          ]);
          return;
        }
        setSendProblem(friendlyMessage(err));
        // The balance or the approvers changed since the preview: work it out again.
        if (code === "INSUFFICIENT_BALANCE" || code === "NO_APPROVER") setAttempt((a) => a + 1);
      },
    });
  }

  return (
    <>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
        <FocusStatusBar />
        <View className="gap-1 px-1">
          <Text className="text-[13px] text-muted-foreground">Payout list, {list.title}</Text>
          <Display size={36}>{formatNaira(amountKobo)}</Display>
          <Text className="text-[15px] text-muted-foreground">
            to {to}
            {source ? ` from ${source.branch.name}` : ""}
          </Text>
        </View>

        {previewing && (
          <View className="flex-row items-center gap-2 px-1">
            <ActivityIndicator size="small" />
            <Text className="text-[14px] text-muted-foreground">Working out the fees and who needs to approve…</Text>
          </View>
        )}

        <DetailList>
          <DetailRow label="From" value={source ? `${source.branch.name}, ${formatAccountNumber(source.accountNumber)}` : "…"} />
          <DetailRow label="Amount" value={`${formatNaira(amountKobo)} to ${to}`} />
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
          <DetailRow
            label="Available"
            value={current ? (current.availableKobo !== null ? formatNaira(current.availableKobo) : "Couldn't be checked just now") : "…"}
          />
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

        {saveItems && changedList && (
          <View className="rounded-field bg-muted px-4 py-3">
            <Text className="text-[14px] leading-5 text-muted-foreground">
              Once it's sent, the list keeps these amounts{included.length < rows.length || listGone > 0 ? ", without the people left out this time" : ""}.
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

        {changedNames.length > 0 && (
          <View accessibilityRole="alert" className="gap-3 rounded-field bg-warning-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-warning-foreground">
              The bank now gives a different name for {changedNames.length === 1 ? "1 account" : `${changedNames.length} accounts`}. Check the highlighted{" "}
              {changedNames.length === 1 ? "row is" : "rows are"} who you mean to pay, or leave {changedNames.length === 1 ? "it" : "them"} out this time.
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pin.busy || previewing} onPress={() => usePayoutRun.getState().acceptRenamed()}>
                {changedNames.length === 1 ? "The new name is right" : "The new names are right"}
              </Button>
              <Button variant="outline" size="sm" disabled={pin.busy || previewing} onPress={() => leaveOut(changedNames.map((c) => c.row.key))}>
                {changedNames.length === 1 ? "Leave it out" : "Leave them out"}
              </Button>
            </View>
          </View>
        )}

        {failed.length > 0 && !previewing && (
          <View className="gap-3 rounded-field bg-destructive-subtle px-4 py-3">
            <Text className="text-[14px] leading-5 text-destructive-foreground">
              {waitingOnBanks
                ? `We couldn't check ${failed.length === 1 ? "1 account" : `${failed.length} accounts`} with the bank just now. Check again in a moment, or leave ${them} out this time to pay the rest.`
                : `${failed.length === 1 ? "1 person can't" : `${failed.length} people can't`} be paid as things are. Leave ${them} out this time to pay the rest.`}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pin.busy} onPress={checkAgain}>
                Check again
              </Button>
              <Button variant="outline" size="sm" disabled={pin.busy} onPress={() => leaveOut(failed.map((c) => c.row.key))}>
                {failed.length === 1 ? "Leave it out" : "Leave them out"}
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
          <RowsCard>
            {checked.map((c) => (
              <PersonRow
                key={c.row.key}
                beneficiary={c.row.beneficiary}
                amountKobo={c.kobo}
                narration={c.unchecked && previewing ? "Working out the fee…" : c.row.narration}
                feeKobo={c.feeKobo}
                savedKobo={c.row.savedKobo}
                problem={c.problem}
                warning={c.was !== undefined ? `The bank's name for this account has changed. You checked “${c.was}”.` : undefined}
              />
            ))}
          </RowsCard>
        </View>

        <View className="gap-3">
          <Button loading={pin.busy} disabled={!ready} onPress={send} icon={{ ios: "paperplane.fill", android: "send" }}>
            {current?.approval.needed ? `Send ${included.length} for approval` : `Pay ${to}`}
          </Button>
          <Button variant="ghost" disabled={pin.busy} onPress={() => router.back()}>
            Change amounts
          </Button>
        </View>
      </ScrollView>
      {pin.sheet}
    </>
  );
}
