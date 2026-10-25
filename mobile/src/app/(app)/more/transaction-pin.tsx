import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Keyboard, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { PasscodeEntry, type EntryResult } from "@/components/security/passcode-entry";
import { ChoosePin, PinModal, ResetPinForm, usePinReset, type ChosenResult } from "@/components/security/transaction-pin";
import { Button, TextButton } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { ListRow, ListSection } from "@/components/ui/list";
import { OptionList, OptionRow } from "@/components/ui/options";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { PasswordField } from "@/components/ui/text-field";
import { Display } from "@/components/ui/typography";
import { useMe } from "@/lib/api/account";
import { friendlyMessage } from "@/lib/api/errors";
import {
  changeTransactionPin,
  isApiCode,
  isPinLocked,
  lockedMessage,
  lockedUntilOf,
  pinStatusQuery,
  resetRequiredOf,
  setTransactionPin,
  useTransactionPinStatus,
  wrongPinMessage,
} from "@/lib/api/transaction-pin";
import type { TransactionPinStatus } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { useTheme } from "@/theme/theme";

type Flow = "set" | "change" | "forgot";

const CHOOSE_SUBTITLE = "4 digits that aren't easy to guess. You'll enter them to confirm payments and team changes.";

/**
 * The transaction PIN (docs/briefs/transaction-pin.md): set, not set or locked, and setting, changing or
 * resetting it. Built like More, Password: the password and code on the page, the PIN on the keypad. The
 * confirmation sheet resets a PIN on the sheet itself, with the same form.
 */
export default function TransactionPinScreen() {
  const status = useTransactionPinStatus();
  const me = useMe();
  const [flow, setFlow] = useState<Flow | null>(null);
  const s = status.data;
  const locked = !!s && isPinLocked(s);
  const { refetch } = status;

  // A lock ends by itself: read the status again once it has.
  const lockedUntil = locked ? s.lockedUntil : null;
  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setTimeout(() => void refetch(), Math.max(0, Date.parse(lockedUntil) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [lockedUntil, refetch]);

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-7 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      {status.isError && <FormError message={friendlyMessage(status.error)} />}
      {!s ? (
        <View className="h-40 rounded-surface bg-muted" />
      ) : (
        <>
          <StatusCard status={s} locked={locked} />
          <ListSection footer="It's separate from this phone's passcode, which only unlocks the app. The same PIN works on the web and for every business you're part of.">
            {!s.isSet ? (
              <ListRow icon={{ ios: "plus.circle", android: "add_circle" }} title="Set your PIN" detail="With your password" onPress={() => setFlow("set")} />
            ) : locked ? (
              <ListRow
                icon={{ ios: "arrow.counterclockwise", android: "lock_reset" }}
                title="Reset PIN"
                detail="With your password and a code we email you"
                onPress={() => setFlow("forgot")}
              />
            ) : (
              [
                <ListRow
                  key="change"
                  icon={{ ios: "pencil", android: "edit" }}
                  title="Change PIN"
                  detail="With your current PIN or your password"
                  onPress={() => setFlow("change")}
                />,
                <ListRow
                  key="forgot"
                  icon={{ ios: "questionmark.circle", android: "help" }}
                  title="Forgot PIN"
                  detail="Reset it with your password and a code we email you"
                  onPress={() => setFlow("forgot")}
                />,
              ]
            )}
          </ListSection>

          {flow === "set" && !s.isSet && <SetPin key="set" hasPassword={me.data?.hasPassword} onDone={() => setFlow(null)} />}
          {flow === "change" && s.isSet && !locked && <ChangePin key="change" onDone={() => setFlow(null)} onForgot={() => setFlow("forgot")} />}
          {flow === "forgot" && s.isSet && <ResetPin key="forgot" email={me.data?.email} onDone={() => setFlow(null)} />}
        </>
      )}
    </KeyboardAwareScrollView>
  );
}

function StatusCard({ status: s, locked }: { status: TransactionPinStatus; locked: boolean }) {
  const { shadows } = useTheme();
  const tries = s.attemptsLeft !== null && s.attemptsLeft < 5 ? ` ${s.attemptsLeft === 1 ? "1 wrong try" : `${s.attemptsLeft} wrong tries`} left before it locks.` : "";
  return (
    <View style={{ boxShadow: shadows.surface }} className="gap-1 rounded-surface bg-card px-5 py-4">
      <Text className="text-[13px] text-muted-foreground">Transaction PIN</Text>
      <Display size={22}>{!s.isSet ? "Not set" : locked ? "Locked" : "Set"}</Display>
      <Text className="text-[14px] leading-5 text-muted-foreground">
        {!s.isSet
          ? "LinkPay asks for these 4 digits before money is sent, approved, locked or taken out of savings, and before your team or approval rule changes."
          : locked
            ? lockedMessage(s.lockedUntil, s.resetRequired)
            : `${s.changedAt ? `Last changed ${formatDate(s.changedAt)}. ` : ""}LinkPay asks for it before money moves or your team changes.${tries}`}
      </Text>
    </View>
  );
}

/** Spinner while the PIN is being saved, otherwise Cancel: the keypad modal can't close mid-request. */
function ModalFooter({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  const { colors } = useTheme();
  if (busy) return <ActivityIndicator color={colors["band-foreground"]} />;
  return (
    <TextButton tone="band" onPress={onCancel}>
      Cancel
    </TextButton>
  );
}

function useRefreshPinStatus() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: pinStatusQuery.queryKey });
}

/** The first PIN: the password, then the PIN twice. An account without a password sets one first. */
function SetPin({ hasPassword, onDone }: { hasPassword?: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const refreshStatus = useRefreshPinStatus();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);

  if (hasPassword === false) {
    return (
      <View className="gap-4">
        <Text className="px-1 text-[15px] leading-[22px] text-foreground">
          You choose a transaction PIN with your LinkPay password, and this account doesn't have one yet. Set one with a code we email you first.
        </Text>
        <Button onPress={() => router.push("/more/password")}>Set a password</Button>
        <Button variant="ghost" onPress={onDone}>
          Cancel
        </Button>
      </View>
    );
  }

  function start() {
    if (!password) return;
    Keyboard.dismiss();
    setError(undefined);
    setPasswordError(undefined);
    setChoosing(true);
  }

  async function save(pin: string): Promise<ChosenResult> {
    setSaving(true);
    try {
      qc.setQueryData(pinStatusQuery.queryKey, await setTransactionPin(pin, password));
    } catch (err) {
      if (isApiCode(err, "WEAK_TRANSACTION_PIN")) return { again: friendlyMessage(err) };
      setChoosing(false);
      if (isApiCode(err, "INCORRECT_PASSWORD")) setPasswordError(friendlyMessage(err));
      else if (isApiCode(err, "PASSWORD_NOT_SET")) void qc.invalidateQueries({ queryKey: ["me"] });
      else if (isApiCode(err, "TRANSACTION_PIN_ALREADY_SET")) {
        refreshStatus();
        Alert.alert("You already have a transaction PIN", "It was set on another device. Change it here if you need to.");
      } else setError(friendlyMessage(err));
      return "error";
    } finally {
      setSaving(false);
    }
    setChoosing(false);
    setPassword("");
    Alert.alert("Transaction PIN set", "LinkPay will ask for it before money moves or your team changes, here and on the web.");
    onDone();
    return "ok";
  }

  return (
    <View className="gap-4">
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">Confirm your password, then choose 4 digits and enter them again.</Text>
      <FormError message={error} />
      <PasswordField
        label="Password"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setPasswordError(undefined);
        }}
        error={passwordError}
        autoComplete="current-password"
        textContentType="password"
        autoFocus
        returnKeyType="next"
        onSubmitEditing={start}
      />
      <View className="gap-3">
        <Button disabled={!password} onPress={start}>
          Choose a PIN
        </Button>
        <Button variant="ghost" onPress={onDone}>
          Cancel
        </Button>
      </View>
      {choosing && (
        <PinModal onRequestClose={() => !saving && setChoosing(false)}>
          <ChoosePin
            title="Choose a PIN"
            subtitle={CHOOSE_SUBTITLE}
            pending={saving ? "Saving your PIN…" : undefined}
            onChosen={save}
            footer={<ModalFooter busy={saving} onCancel={() => setChoosing(false)} />}
          />
        </PinModal>
      )}
    </View>
  );
}

/**
 * A new PIN, confirmed with the current PIN (entered on the keypad first; a wrong one counts toward the lock)
 * or the password. The server checks the current PIN with the change itself, so it's held until that request.
 */
function ChangePin({ onDone, onForgot }: { onDone: () => void; onForgot: () => void }) {
  const qc = useQueryClient();
  const refreshStatus = useRefreshPinStatus();
  const [method, setMethod] = useState<"pin" | "password">("pin");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [error, setError] = useState<string>();
  const [step, setStep] = useState<"current" | "new">();
  const [current, setCurrent] = useState<string>();
  const [currentMessage, setCurrentMessage] = useState<string>();
  const [saving, setSaving] = useState(false);

  function start() {
    if (method === "password" && !password) return;
    Keyboard.dismiss();
    setError(undefined);
    setPasswordError(undefined);
    setCurrentMessage(undefined);
    setStep(method === "pin" ? "current" : "new");
  }

  function close() {
    setStep(undefined);
    setCurrent(undefined);
  }

  async function enterCurrent(pin: string): Promise<EntryResult> {
    setCurrent(pin);
    setStep("new");
    return "keep";
  }

  async function save(newPin: string): Promise<ChosenResult> {
    setSaving(true);
    try {
      qc.setQueryData(pinStatusQuery.queryKey, await changeTransactionPin(newPin, method === "pin" ? { currentPin: current! } : { password }));
    } catch (err) {
      // Refused before the current PIN was checked, so it's kept for the next choice.
      if (isApiCode(err, "WEAK_TRANSACTION_PIN")) return { again: friendlyMessage(err) };
      setCurrent(undefined);
      if (isApiCode(err, "TRANSACTION_PIN_INVALID")) {
        refreshStatus();
        setCurrentMessage(wrongPinMessage(err));
        setStep("current");
        return "error";
      }
      close();
      if (isApiCode(err, "TRANSACTION_PIN_LOCKED")) {
        // The page switches to the lock and Reset PIN straight away.
        const lockedUntil = lockedUntilOf(err);
        const resetRequired = resetRequiredOf(err);
        qc.setQueryData<TransactionPinStatus>(pinStatusQuery.queryKey, (s) => s && { ...s, locked: true, lockedUntil, attemptsLeft: 0, resetRequired });
        refreshStatus();
      } else if (isApiCode(err, "INCORRECT_PASSWORD")) setPasswordError(friendlyMessage(err));
      else if (isApiCode(err, "TRANSACTION_PIN_REQUIRED")) refreshStatus();
      else setError(friendlyMessage(err));
      return "error";
    } finally {
      setSaving(false);
    }
    close();
    setPassword("");
    Alert.alert("Transaction PIN changed", "Use your new PIN from now on, here and on the web.");
    onDone();
    return "ok";
  }

  return (
    <View className="gap-4">
      <OptionList label="Confirm it's you with">
        <OptionRow title="Your current PIN" selected={method === "pin"} onPress={() => setMethod("pin")} />
        <OptionRow title="Your password" selected={method === "password"} onPress={() => setMethod("password")} />
      </OptionList>
      <FormError message={error} />
      {method === "password" && (
        <PasswordField
          label="Password"
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            setPasswordError(undefined);
          }}
          error={passwordError}
          autoComplete="current-password"
          textContentType="password"
          autoFocus
          returnKeyType="next"
          onSubmitEditing={start}
        />
      )}
      <View className="gap-3">
        <Button disabled={method === "password" && !password} onPress={start}>
          Continue
        </Button>
        <Button variant="ghost" onPress={onDone}>
          Cancel
        </Button>
      </View>
      {step && (
        <PinModal onRequestClose={() => !saving && close()}>
          {step === "current" ? (
            <PasscodeEntry
              title="Enter your current PIN"
              subtitle="Then choose a new one."
              message={currentMessage}
              onComplete={enterCurrent}
              footer={
                <View className="flex-row items-center gap-8">
                  <TextButton
                    tone="band"
                    onPress={() => {
                      close();
                      onForgot();
                    }}
                  >
                    Forgot PIN?
                  </TextButton>
                  <TextButton tone="band" onPress={close}>
                    Cancel
                  </TextButton>
                </View>
              }
            />
          ) : (
            <ChoosePin
              title="Choose a new PIN"
              subtitle={CHOOSE_SUBTITLE}
              pending={saving ? "Saving your PIN…" : undefined}
              onChosen={save}
              footer={<ModalFooter busy={saving} onCancel={close} />}
            />
          )}
        </PinModal>
      )}
    </View>
  );
}

/** A forgotten or locked PIN: a code by email, then the code, the password and a new PIN. Ends a lock too. */
function ResetPin({ email, onDone }: { email?: string; onDone: () => void }) {
  const reset = usePinReset(email);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(newPin: string): Promise<ChosenResult> {
    setSaving(true);
    const saved = await reset.save(newPin);
    setSaving(false);
    if (typeof saved === "object") return saved;
    setChoosing(false);
    if (saved === "failed") return "error";
    Alert.alert("Transaction PIN reset", "Use your new PIN from now on, here and on the web. If it was locked, it works again.");
    onDone();
    return "ok";
  }

  return (
    <View className="gap-4">
      <Text className="px-1 text-[15px] leading-[22px] text-foreground">{reset.intro}</Text>
      <ResetPinForm
        reset={reset}
        onChoose={() => setChoosing(true)}
        cancel={
          <Button variant="ghost" onPress={onDone}>
            Cancel
          </Button>
        }
      />
      {choosing && (
        <PinModal onRequestClose={() => !saving && setChoosing(false)}>
          <ChoosePin
            title="Choose a new PIN"
            subtitle={CHOOSE_SUBTITLE}
            pending={saving ? "Saving your PIN…" : undefined}
            onChosen={save}
            footer={<ModalFooter busy={saving} onCancel={() => setChoosing(false)} />}
          />
        </PinModal>
      )}
    </View>
  );
}
