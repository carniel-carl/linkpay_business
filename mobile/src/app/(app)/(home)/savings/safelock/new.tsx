import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { SafelockTile } from "@/components/savings/safelock-parts";
import { ConfirmPasscode } from "@/components/security/confirm-passcode";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { can, useAccounts } from "@/lib/api/banking";
import { ApiError, friendlyMessage } from "@/lib/api/errors";
import { useCreateSafelock, useSafelockLimits } from "@/lib/api/safelocks";
import type { Branch, SafelockLimits } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/store";
import { cn } from "@/lib/cn";
import { formatNaira } from "@/lib/format";
import { addDays, daysBetween, formatDay, todayInLagos } from "@/lib/invoices";
import { SAFELOCK_PRESETS } from "@/lib/savings";
import { unlockWithBiometrics } from "@/lib/security/biometrics";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

/** On create, the web's wording: what can't be locked is money already held or saved. */
const NOT_ENOUGH = "That's more than this branch has available. Money held for transfers or already saved can't be locked.";

/**
 * New Safelock: branch, name, amount and unlock date, then a confirmation that it can't be undone (a tick,
 * then Face ID or the passcode, as for sending money). The window and amounts come from the server.
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
  const create = useCreateSafelock();
  const accounts = useAccounts(true);
  const biometrics = useAuth((s) => s.biometrics);
  const biometricsChanged = useAuth((s) => s.biometricsChanged);
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
  const [askPasscode, setAskPasscode] = useState(false);
  const [serverField, setServerField] = useState<{ amount?: string; unlockOn?: string }>({});
  // Kept for this lock, so a create whose answer got lost can't lock the money twice.
  const [key, setKey] = useState(() => Crypto.randomUUID());

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

  // Locking can't be undone, so it's confirmed like a send: Face ID, or the passcode.
  async function confirm() {
    if (biometrics) {
      const result = await unlockWithBiometrics(`Lock ${formatNaira(kobo!)}`);
      if (result === "ok") return lock();
      if (result === "changed") biometricsChanged();
    }
    setAskPasscode(true);
  }

  function lock() {
    setAskPasscode(false);
    create.mutate(
      { input: { branch: branch!, title: title.trim(), amountKobo: kobo!, unlockOn }, idempotencyKey: key },
      {
        onSuccess: (saved) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace({ pathname: "/savings/safelock/[id]", params: { id: saved._id, created: "1" } });
        },
        onError: (err) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          // A refused lock gets a new key, so the corrected one isn't taken for a replay. A busy account may
          // still be working on this one, so its key stays.
          if (!(err instanceof ApiError) || err.code !== "ACCOUNT_BUSY") setKey(Crypto.randomUUID());
          if (err instanceof ApiError && (err.code === "SAFELOCK_TOO_SMALL" || err.code === "INSUFFICIENT_BALANCE")) {
            setServerField({ amount: err.code === "INSUFFICIENT_BALANCE" ? NOT_ENOUGH : friendlyMessage(err) });
            setStep("details");
          } else if (err instanceof ApiError && err.code === "INVALID_UNLOCK_DATE") {
            setServerField({ unlockOn: friendlyMessage(err) });
            setStep("details");
          }
        },
      },
    );
  }

  const fieldError = create.error instanceof ApiError && ["SAFELOCK_TOO_SMALL", "INSUFFICIENT_BALANCE", "INVALID_UNLOCK_DATE"].includes(create.error.code ?? "");

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

          <FormError message={create.error && !fieldError ? friendlyMessage(create.error) : undefined} />

          <View className="gap-3">
            <Button loading={create.isPending} disabled={!agreed} onPress={() => void confirm()} icon={{ ios: "lock.fill", android: "lock" }}>
              {`Lock ${formatNaira(kobo!)}`}
            </Button>
            <Button variant="ghost" disabled={create.isPending} onPress={() => setStep("details")}>
              Back
            </Button>
          </View>
        </ScrollView>
        {askPasscode && (
          <ConfirmPasscode
            title={`Lock ${formatNaira(kobo!)}?`}
            subtitle={`Enter your passcode to lock it until ${formatDay(unlockOn)}.`}
            onConfirmed={lock}
            onCancel={() => setAskPasscode(false)}
          />
        )}
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

      <TextField
        label="Amount to lock (₦)"
        value={amount}
        onChangeText={(v) => {
          setAmount(v.replace(/[^\d.,]/g, ""));
          setServerField((f) => ({ ...f, amount: undefined }));
        }}
        keyboardType="decimal-pad"
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
