import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Logo } from "@/components/brand/logo";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { PasswordField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { useMe } from "@/lib/api/account";
import { friendlyMessage } from "@/lib/api/errors";
import {
  isApiCode,
  isPinLocked,
  lockedMessage,
  lockedUntilOf,
  pinStatusQuery,
  setTransactionPin,
  wrongPinMessage,
} from "@/lib/api/transaction-pin";
import { SchemeScope, useTheme } from "@/theme/theme";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";
import { ChoosePin, PinModal, PinNotice, type ChosenResult } from "./transaction-pin";

/**
 * Confirming a covered action (docs/briefs/transaction-pin.md) with the server-checked transaction PIN. It
 * replaces the app passcode and Face ID for these actions; the passcode still unlocks the app.
 *
 *   const pin = useTransactionPin();
 *   pin.ask({ title, subtitle, run: (entered) => sendTransfer(body, keyFor(body), entered), onSuccess, onError });
 *   return <>{...}{pin.sheet}</>;
 *
 * The PIN lives in the keypad's state for one try: `run` puts it on that request's header, and it's cleared
 * whatever the answer. A wrong or missing PIN asks again on the same sheet, so `run` is called again with the
 * same body and keeps its Idempotency-Key. No PIN yet: the sheet sets one up (password, then the PIN twice) and
 * carries on with the action. Anything that isn't about the PIN closes the sheet and goes to `onError`.
 */
export type PinRequest<T> = {
  /** The keypad's title: what's about to happen, e.g. "Send ₦25,000?". */
  title: string;
  /** What the PIN confirms, e.g. "Enter your transaction PIN to send ₦25,000 to Ada Obi." */
  subtitle: string;
  /** Under the dots while the request runs. */
  pending?: string;
  /** Makes the covered request with this PIN as its X-Transaction-Pin header. */
  run: (pin: string) => Promise<T>;
  onSuccess: (result: T) => void;
  /** Anything that isn't about the PIN (not enough money, offline, timed out). The sheet has closed by then. */
  onError?: (err: unknown) => void;
};

type Step =
  | { kind: "enter"; message?: string }
  | { kind: "locked"; until: string | null }
  | { kind: "password"; error?: string }
  | { kind: "choose"; password: string }
  | { kind: "noPassword" };

type Job = {
  id: number;
  title: string;
  subtitle: string;
  pending: string;
  run: (pin: string) => Promise<unknown>;
  succeed: (result: unknown) => void;
  fail: (err: unknown) => void;
  start: Step;
};

export function useTransactionPin() {
  const qc = useQueryClient();
  const [job, setJob] = useState<Job>();
  const [opening, setOpening] = useState(false);
  const open = useRef(false);
  const ids = useRef(0);

  const ask = useCallback(
    async <T,>(req: PinRequest<T>) => {
      if (open.current) return;
      open.current = true;
      // The keypad is the app's own; a system keyboard left up from the form would cover it.
      Keyboard.dismiss();
      setOpening(true);
      // Open on the right step: every account starts without a PIN, so that's set first rather than asking for
      // digits that don't exist; a locked PIN shows when it unlocks. Without the status, the server decides.
      const status = await qc.fetchQuery({ ...pinStatusQuery, staleTime: 15_000 }).catch(() => undefined);
      setOpening(false);
      const start: Step =
        status && !status.isSet
          ? { kind: "password" }
          : status && isPinLocked(status)
            ? { kind: "locked", until: status.lockedUntil }
            : { kind: "enter" };
      setJob({
        id: ++ids.current,
        title: req.title,
        subtitle: req.subtitle,
        pending: req.pending ?? "Checking…",
        run: req.run,
        succeed: (result) => req.onSuccess(result as T),
        fail: (err) => req.onError?.(err),
        start,
      });
    },
    [qc],
  );

  const close = useCallback(() => {
    open.current = false;
    setJob(undefined);
  }, []);

  return { ask, busy: opening || !!job, sheet: job ? <TransactionPinSheet key={job.id} job={job} onClose={close} /> : null };
}

function TransactionPinSheet({ job, onClose }: { job: Job; onClose: () => void }) {
  const qc = useQueryClient();
  const { colors } = useTheme();
  const me = useMe();
  const [step, setStep] = useState<Step>(job.start);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<string>();

  const refreshStatus = useCallback(() => void qc.invalidateQueries({ queryKey: pinStatusQuery.queryKey }), [qc]);

  // A lock ends by itself: back to the keypad once it has.
  useEffect(() => {
    if (step.kind !== "locked" || !step.until) return;
    const timer = setTimeout(() => {
      refreshStatus();
      setStep({ kind: "enter" });
    }, Math.max(0, Date.parse(step.until) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [step, refreshStatus]);

  function succeed(result: unknown) {
    refreshStatus();
    onClose();
    job.succeed(result);
  }

  const cancel = () => {
    if (!running) onClose();
  };

  function resetPin() {
    onClose();
    router.push({ pathname: "/more/transaction-pin", params: { reset: "1" } });
  }

  /** The covered request failed. A PIN problem keeps the sheet open on the right step; anything else closes it. */
  function failed(err: unknown): EntryResult {
    if (isApiCode(err, "TRANSACTION_PIN_INVALID")) {
      refreshStatus();
      setStep({ kind: "enter", message: wrongPinMessage(err) });
      return "error";
    }
    if (isApiCode(err, "TRANSACTION_PIN_MISSING")) {
      setStep({ kind: "enter", message: "Enter your 4-digit transaction PIN." });
      return "error";
    }
    if (isApiCode(err, "TRANSACTION_PIN_LOCKED")) {
      refreshStatus();
      setStep({ kind: "locked", until: lockedUntilOf(err) });
      return "error";
    }
    if (isApiCode(err, "TRANSACTION_PIN_REQUIRED")) {
      refreshStatus();
      setStep({ kind: "password" });
      return "keep";
    }
    onClose();
    job.fail(err);
    // The screen gives the feedback for its own errors.
    return "keep";
  }

  async function run(pin: string): Promise<EntryResult> {
    setRunning(true);
    setPending(job.pending);
    try {
      succeed(await job.run(pin));
      return "ok";
    } catch (err) {
      return failed(err);
    } finally {
      setRunning(false);
      setPending(undefined);
    }
  }

  /** First PIN: save it with the password, then carry on with the action using it. */
  async function chosen(pin: string, password: string): Promise<ChosenResult> {
    setRunning(true);
    setPending("Saving your PIN…");
    try {
      qc.setQueryData(pinStatusQuery.queryKey, await setTransactionPin(pin, password));
    } catch (err) {
      setRunning(false);
      setPending(undefined);
      if (isApiCode(err, "WEAK_TRANSACTION_PIN")) return { again: friendlyMessage(err) };
      if (isApiCode(err, "TRANSACTION_PIN_ALREADY_SET")) {
        // Set somewhere else meanwhile (the web, another phone).
        refreshStatus();
        setStep({ kind: "enter", message: "You already have a transaction PIN. Enter it to continue." });
      } else if (isApiCode(err, "PASSWORD_NOT_SET")) setStep({ kind: "noPassword" });
      else setStep({ kind: "password", error: friendlyMessage(err) });
      return "error";
    }
    return run(pin);
  }

  const spinner = <ActivityIndicator color={colors["band-foreground"]} />;
  const cancelButton = (
    <TextButton tone="band" onPress={cancel}>
      Cancel
    </TextButton>
  );

  let body: ReactNode;
  if (step.kind === "enter") {
    body = (
      <PasscodeEntry
        title={job.title}
        subtitle={job.subtitle}
        message={pending ?? step.message}
        messageTone={pending ? "muted" : "error"}
        onComplete={run}
        footer={
          running ? (
            spinner
          ) : (
            <View className="flex-row items-center gap-8">
              <TextButton tone="band" onPress={resetPin}>
                Forgot PIN?
              </TextButton>
              {cancelButton}
            </View>
          )
        }
      />
    );
  } else if (step.kind === "locked") {
    body = <PinNotice title="PIN locked" body={lockedMessage(step.until)} action="Reset PIN" onAction={resetPin} onCancel={onClose} />;
  } else if (step.kind === "noPassword" || (step.kind === "password" && me.data?.hasPassword === false)) {
    body = (
      <PinNotice
        title="Set a password first"
        body="You choose a transaction PIN with your LinkPay password, and this account doesn't have one yet. Set one with a code we email you, then try again."
        action="Set a password"
        onAction={() => {
          onClose();
          router.push("/more/password");
        }}
        onCancel={onClose}
      />
    );
  } else if (step.kind === "password") {
    body = <PasswordStep error={step.error} onContinue={(password) => setStep({ kind: "choose", password })} onCancel={onClose} />;
  } else {
    const { password } = step;
    body = (
      <ChoosePin
        title="Choose a PIN"
        subtitle="4 digits that aren't easy to guess. You'll enter them to confirm payments and team changes."
        pending={pending}
        onChosen={(pin) => chosen(pin, password)}
        footer={running ? spinner : cancelButton}
      />
    );
  }

  return <PinModal onRequestClose={cancel}>{body}</PinModal>;
}

/** Setting the first PIN starts with the account password, on the band in the auth screens' dark palette. */
function PasswordStep({ error, onContinue, onCancel }: { error?: string; onContinue: (password: string) => void; onCancel: () => void }) {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const submit = () => {
    if (password) onContinue(password);
  };
  return (
    <SchemeScope scheme="dark">
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 28, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
      >
        <View className="pt-3">
          <Logo onBand size={40} />
        </View>
        <View className="gap-2.5 pb-7 pt-9">
          <Display size={30}>Set your transaction PIN</Display>
          <Text className="text-[15px] leading-[22px] text-muted-foreground">
            LinkPay asks for these 4 digits before money moves or your team changes. It's separate from this phone's passcode. Enter your password to
            choose one; once it's set, this goes ahead.
          </Text>
        </View>
        <View className="gap-5">
          <FormError message={error} />
          <PasswordField
            label="Password"
            value={password}
            onChangeText={setPassword}
            autoComplete="current-password"
            textContentType="password"
            autoFocus
            returnKeyType="next"
            onSubmitEditing={submit}
          />
          <Button disabled={!password} onPress={submit}>
            Continue
          </Button>
          <TextButton className="self-center" onPress={onCancel}>
            Cancel
          </TextButton>
        </View>
      </KeyboardAwareScrollView>
    </SchemeScope>
  );
}
