import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { SafelockTile } from "@/components/savings/safelock-parts";
import { useTransactionPin } from "@/components/security/transaction-pin-sheet";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { NairaField } from "@/components/ui/naira-field";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { can, useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { createSafelock, safelockKeys, useSafelockCreated, useSafelockLimits } from "@/lib/api/safelocks";
import type { Branch, SafelockLimits } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNaira, formatNairaShort } from "@/lib/format";
import { addDays, daysBetween, formatDay, todayInLagos } from "@/lib/invoices";
import { SAFELOCK_PRESETS } from "@/lib/savings";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** On create, the web's wording: what can't be locked is money already held or saved. */
const NOT_ENOUGH = "That's more than this branch has available. Money held for transfers or already saved can't be locked.";

/**
 * New Safelock: branch, name, amount and unlock date, then a confirmation that it can't be undone (a tick,
 * then the transaction PIN, as for sending money). The window and amounts come from the server.
 */
export default function NewSafelock() {
  const { branch } = useLocalSearchParams<{ branch?: string }>();
  const gate = useBankingGate();
  const ready = gate.state === "ready";
  const manager = ready && can(gate.overview, "savings.manage");
  const limits = useSafelockLimits(manager);

  if (manager && limits.data) {
    return <Form limits={limits.data} branches={gate.overview.branches.filter((b) => b.account)} initialBranch={branch} />;
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
      <FocusStatusBar />
      {limits.isError ? (
        <View className="gap-3">
          <FormError message={friendlyMessage(limits.error)} />
          <Button variant="outline" onPress={() => void limits.refetch()}>
            Try again
          </Button>
        </View>
      ) : gate.state === "loading" || (manager && limits.isPending) ? (
        <View className="h-40 rounded-surface bg-muted" />
      ) : gate.state !== "ready" ? (
        <GateMessage gate={gate} />
      ) : (
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Your role doesn&apos;t include moving money into savings. Ask an owner or admin.
        </Text>
      )}
    </ScrollView>
  );
}

function Form({ limits, branches, initialBranch }: { limits: SafelockLimits; branches: Branch[]; initialBranch?: string }) {
  const { colors } = useTheme();
  const created = useSafelockCreated();
  const pin = useTransactionPin();
  const accounts = useAccounts(true);
  const today = todayInLagos();
  const presets = SAFELOCK_PRESETS.filter((d) => d >= limits.minDays && d <= limits.maxDays);

  const [step, setStep] = useState<"details" | "confirm">("details");
  const [branch, setBranch] = useState(
    (branches.some((b) => b._id === initialBranch) ? initialBranch : undefined) ?? (branches.length === 1 ? branches[0]._id : undefined),
  );
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [unlockOn, setUnlockOn] = useState(() => {
    const preset = presets.includes(90) ? addDays(today, 90) : limits.earliestUnlockOn;
    return preset < limits.earliestUnlockOn || preset > limits.latestUnlockOn ? limits.earliestUnlockOn : preset;
  });
  // Bumped by a preset, so the calendar reopens on that month.
  const [presetPicks, setPresetPicks] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // What the last try came to, when it didn't lock the money: shown on the confirm step.
  const [error, setError] = useState<unknown>();
  const [serverField, setServerField] = useState<{ amount?: string; unlockOn?: string }>({});

  const picked = branches.find((b) => b._id === branch);
  const account = accounts.data?.find((a) => a.branch._id === branch);
  const available = account?.balance ? (account.balance.availableKobo ?? account.balance.amountKobo) : undefined;
  const kobo = parseNaira(amount);
  const days = daysBetween(today, unlockOn);

  // Copy from the web's Safelock form.
  const errors = {
    branch: !branch ? "Choose a branch." : undefined,
    title: !title.trim() ? "Give the Safelock a name." : undefined,
    amount:
      kobo === undefined
        ? "Enter an amount."
        : kobo < limits.minAmountKobo
          ? `Lock at least ${formatNaira(limits.minAmountKobo)}.`
          : kobo > limits.maxAmountKobo
            ? `You can lock up to ${formatNaira(limits.maxAmountKobo)} at a time.`
            : available !== undefined && kobo > available && picked
              ? `${picked.name} has ${formatNaira(available)} available.`
              : serverField.amount,
    unlockOn:
      unlockOn < limits.earliestUnlockOn || unlockOn > limits.latestUnlockOn
        ? `Choose a date from ${formatDay(limits.earliestUnlockOn)} to ${formatDay(limits.latestUnlockOn)}.`
        : serverField.unlockOn,
  };
  const shown = (k: keyof typeof errors) => (submitted ? errors[k] : undefined);

  function review() {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    setAgreed(false);
    setStep("confirm");
  }

  // Locking can't be undone, so it's confirmed like a send: with the transaction PIN (it replaced Face ID and the passcode here).
  function confirm() {
    setError(undefined);
    const input = { branch: branch!, title: title.trim(), amountKobo: kobo!, unlockOn };
    const amount = formatNairaShort(kobo!);
    void pin.ask({
      title: `Lock ${amount}?`,
      subtitle: `Enter your transaction PIN to lock ${amount} until ${formatDay(unlockOn)}.`,
      pending: "Locking…",
      // The same details keep the same key, a corrected PIN too, even after leaving this form and filling it in again
      // (safelockKeys), so a lock whose answer got lost can't happen twice.
      run: (entered) => createSafelock(input, safelockKeys.keyFor(input), entered),
      onSuccess: (saved) => {
        // The next lock is a new request.
        safelockKeys.reset();
        created(saved);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace({ pathname: "/savings/safelock/[id]", params: { id: saved._id, created: "1" } });
      },
      onError: (err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(err);
        // The key was used for other details: a deliberate retry is a new request.
        if (err instanceof ApiError && err.code === "IDEMPOTENCY_KEY_REUSED") safelockKeys.reset();
        if (err instanceof ApiError && (err.code === "SAFELOCK_TOO_SMALL" || err.code === "INSUFFICIENT_BALANCE")) {
          setServerField({ amount: err.code === "INSUFFICIENT_BALANCE" ? NOT_ENOUGH : friendlyMessage(err) });
          setStep("details");
        } else if (err instanceof ApiError && err.code === "INVALID_UNLOCK_DATE") {
          setServerField({ unlockOn: friendlyMessage(err) });
          setStep("details");
        }
      },
    });
  }

  const fieldError = error instanceof ApiError && ["SAFELOCK_TOO_SMALL", "INSUFFICIENT_BALANCE", "INVALID_UNLOCK_DATE"].includes(error.code ?? "");

  if (step === "confirm") {
    return (
      <>
        <Stack.Screen options={{ title: "Check and lock" }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-4 pb-12 pt-4">
          <FocusStatusBar />
          <View className="gap-1 px-1">
            <Text className="text-[13px] text-muted-foreground">Lock {formatNaira(kobo!)}?</Text>
            <Display size={36}>{formatNaira(kobo!)}</Display>
            <Text className="text-[15px] text-muted-foreground">Check the details. Once it&apos;s locked, nobody can undo it.</Text>
          </View>

          <DetailList>
            <DetailRow label="Name" value={title.trim()} />
            <DetailRow label="From" value={picked?.name ?? ""} />
            <DetailRow label="Unlocks on" value={`${formatDay(unlockOn)}, in ${days.toLocaleString("en-NG")} days`} />
          </DetailList>

          <View className="gap-3 rounded-field bg-warning-subtle p-4">
            <View className="flex-row items-start gap-2.5">
              <Icon ios="lock.fill" android="lock" size={16} color={colors["warning-foreground"]} />
              <Text className="flex-1 text-[14px] leading-5 text-warning-foreground">
                You can&apos;t take this money out, add to it or change the date before {formatDay(unlockOn)}, even in an
                emergency. It doesn&apos;t earn interest.
              </Text>
            </View>
            <Agree checked={agreed} onChange={setAgreed} label={`I understand the money stays locked until ${formatDay(unlockOn)}.`} />
          </View>

          <FormError message={error && !fieldError ? lockError(error) : undefined} />

          <View className="gap-3">
            <Button loading={pin.busy} disabled={!agreed} onPress={confirm} icon={{ ios: "lock.fill", android: "lock" }}>
              {`Lock ${formatNaira(kobo!)}`}
            </Button>
            <Button variant="ghost" disabled={pin.busy} onPress={() => setStep("details")}>
              Back
            </Button>
          </View>
        </ScrollView>
        {pin.sheet}
      </>
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-7 px-4 pb-12 pt-4"
    >
      <Stack.Screen options={{ title: "New Safelock" }} />
      <FocusStatusBar />
      <View className="flex-row items-center gap-3 px-1">
        <SafelockTile size={56} />
        <Text numberOfLines={2} className="flex-1 text-[15px] leading-[21px] text-muted-foreground">
          Money you lock stays in the branch&apos;s account, but nobody can spend it or take it out until the date you choose.
        </Text>
      </View>

      <TextField
        label="Name"
        value={title}
        onChangeText={(v) => setTitle(v.slice(0, 40))}
        placeholder="Office rent 2027"
        maxLength={40}
        autoCapitalize="sentences"
        error={shown("title")}
      />

      {branches.length > 1 && (
        <OptionList label="Branch" hint="The money is locked in this branch's account." error={shown("branch")}>
          {branches.map((b) => (
            <OptionRow
              key={b._id}
              title={b.name}
              detail={b.isHeadOffice ? "Head office" : undefined}
              selected={branch === b._id}
              onPress={() => {
                setBranch(b._id);
                setServerField({});
              }}
            />
          ))}
        </OptionList>
      )}

      <NairaField
        label="Amount to lock (₦)"
        value={amount}
        onChangeText={(v) => {
          setAmount(v);
          setServerField((f) => ({ ...f, amount: undefined }));
        }}
        error={shown("amount")}
        hint={`${available !== undefined && picked ? `${formatNaira(available)} available in ${picked.name}. ` : ""}At least ${formatNaira(limits.minAmountKobo)}.`}
        style={{ fontFamily: "BricolageText-SemiBold", fontSize: 20 }}
      />

      <View className="gap-3">
        <Text className="text-[14px] font-medium text-foreground">Unlocks on</Text>
        {presets.length > 0 && (
          <View accessibilityRole="radiogroup" accessibilityLabel="Lock for" className="flex-row flex-wrap gap-2">
            {presets.map((d) => {
              const day = addDays(today, d);
              const checked = unlockOn === day;
              return (
                <Pressable
                  key={d}
                  accessibilityRole="radio"
                  accessibilityState={{ checked }}
                  onPress={() => {
                    setUnlockOn(day);
                    setPresetPicks((n) => n + 1);
                    setServerField((f) => ({ ...f, unlockOn: undefined }));
                  }}
                  className={cn("h-9 justify-center rounded-full px-3.5 active:opacity-70", checked ? "bg-primary" : "border border-input bg-card")}
                >
                  <Text className={cn("text-[14px] font-medium", checked ? "text-primary-foreground" : "text-foreground")}>
                    {d === 365 ? "1 year" : `${d} days`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        <DateField
          // A preset moves the calendar to its month.
          key={presetPicks}
          label="Unlock date"
          value={unlockOn}
          onChange={(day) => {
            setUnlockOn(day);
            setServerField((f) => ({ ...f, unlockOn: undefined }));
          }}
          min={limits.earliestUnlockOn}
          max={limits.latestUnlockOn}
          error={shown("unlockOn")}
          hint={
            days > 0
              ? `Locked for ${days.toLocaleString("en-NG")} days. It unlocks at midnight at the start of that day.`
              : `Between ${limits.minDays} and ${limits.maxDays.toLocaleString("en-NG")} days from today.`
          }
        />
      </View>

      <Button onPress={review}>Continue</Button>
    </KeyboardAwareScrollView>
  );
}

/** The required tick before locking. */
function Agree({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync();
        onChange(!checked);
      }}
      hitSlop={6}
      className="flex-row items-start gap-2.5"
    >
      <View
        className={cn(
          "mt-px h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[1.5px]",
          checked ? "border-primary bg-primary" : "border-input bg-card",
        )}
      >
        {checked && <Icon ios="checkmark" android="check" size={14} color={colors["primary-foreground"]} />}
      </View>
      <Text className="flex-1 text-[14px] leading-5 text-foreground">{label}</Text>
    </Pressable>
  );
}

/** A lock that timed out may still have gone through, so the message says to look before trying again. */
function lockError(err: unknown) {
  if (err instanceof ApiError && err.code === "TIMEOUT") {
    return "That took too long, so the money may already be locked. Check your Safelocks before you try again.";
  }
  if (err instanceof ApiError && err.code === "IDEMPOTENCY_KEY_REUSED") {
    return "These details changed after they were first sent. Check your Safelocks to see whether the money was locked before you try again.";
  }
  return friendlyMessage(err);
}
