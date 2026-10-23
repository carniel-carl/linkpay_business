import { useQueryClient } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { useRef, useState, type ReactNode } from "react";
import { Keyboard, Modal, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ResendCode } from "@/components/auth/resend-code";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { CodeField } from "@/components/ui/code-field";
import { FormError } from "@/components/ui/form-error";
import { PasswordField, type TextInputRef } from "@/components/ui/text-field";
import { friendlyMessage } from "@/lib/api/errors";
import { isApiCode, isWeakPin, pinStatusQuery, requestTransactionPinReset, resetTransactionPin, WEAK_PIN } from "@/lib/api/transaction-pin";
import { useAuth } from "@/lib/auth/store";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

// Building blocks for the transaction PIN: the navy modal its keypad sits in, choosing a new PIN, a message
// screen for a locked PIN or a missing password, and the reset form. Used by the confirmation sheet and More,
// Transaction PIN.

/**
 * A native full-screen modal on the navy band, like the passcode confirmation, so it covers the header and tab
 * bar. It hides while the app is locked, so the lock screen is never under it; what it holds comes back after.
 * The top inset comes from the app's provider: a SafeAreaView inside an iOS Modal measures no inset, which put
 * the logo under the status bar and Dynamic Island.
 */
export function PinModal({ children, onRequestClose }: { children: ReactNode; onRequestClose: () => void }) {
  const locked = useAuth((s) => s.status === "locked");
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!locked} animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent navigationBarTranslucent>
      <View className="flex-1 bg-band">
        <StatusBar style="light" />
        <View style={{ flex: 1, paddingTop: insets.top + 16 }}>{children}</View>
      </View>
    </Modal>
  );
}

/**
 * What saving a chosen PIN came to: "ok" (pulse), "error" (shake: it failed and the caller moved on), "keep"
 * (no feedback: the caller has closed it), or choose again with a message.
 */
export type ChosenResult = EntryResult | { again: string };

/**
 * Choose a new 4-digit PIN, then enter it again. Weak PINs (the server's rule) are refused before the confirm
 * step. `onChosen` saves it; while it runs, `pending` shows under the dots. The PIN is the same length as the
 * passcode, so the passcode keypad and dots serve both.
 */
export function ChoosePin({
  title,
  subtitle,
  pending,
  onChosen,
  footer,
}: {
  title: string;
  subtitle: string;
  pending?: string;
  onChosen: (pin: string) => Promise<ChosenResult>;
  footer?: ReactNode;
}) {
  const [first, setFirst] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function complete(pin: string): Promise<EntryResult> {
    if (!first) {
      if (isWeakPin(pin)) {
        setMessage(WEAK_PIN);
        return "error";
      }
      setFirst(pin);
      setMessage(undefined);
      return "keep";
    }
    if (pin !== first) {
      setFirst(undefined);
      setMessage("Those PINs don't match. Start again.");
      return "error";
    }
    setMessage(undefined);
    const result = await onChosen(pin);
    setFirst(undefined);
    if (typeof result === "object") {
      setMessage(result.again);
      return "error";
    }
    return result;
  }

  return (
    <PasscodeEntry
      title={first ? "Enter it again" : title}
      subtitle={first ? "Confirm your new transaction PIN." : subtitle}
      message={pending ?? message}
      messageTone={pending ? "muted" : "error"}
      onComplete={complete}
      footer={footer}
    />
  );
}

/**
 * A full-band message with one main action and, with `onCancel`, a way out: a locked PIN, an account without a
 * password, or a PIN saved just before the action failed (that one only moves on).
 */
export function PinNotice({
  title,
  body,
  action,
  onAction,
  onCancel,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  onCancel?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 px-7" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
      <Animated.View entering={FadeIn.duration(260)} className="pt-3">
        <Logo onBand size={40} />
      </Animated.View>
      <Animated.View entering={FadeIn.duration(320)} className="flex-1 justify-center">
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.25}
          className="text-band-foreground"
          style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: 36, letterSpacing: -1.2, lineHeight: 38 }}
        >
          {title}
        </Text>
        <Text accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3} className="mt-2.5 max-w-[320px] text-[15px] leading-[22px] text-band-muted">
          {body}
        </Text>
      </Animated.View>
      <View className="gap-3">
        <Button variant="pop" onPress={onAction} className="h-14">
          {action}
        </Button>
        {onCancel && (
          <Button variant="band" onPress={onCancel} className="h-14">
            Cancel
          </Button>
        )}
      </View>
    </View>
  );
}

/** What saving a reset PIN came to: saved, "failed" (the form now says why), or choose again with a message. */
export type ResetSaved = "saved" | "failed" | { again: string };

export type PinReset = ReturnType<typeof usePinReset>;

/**
 * A forgotten or locked PIN: a code by email, then the code, the password and a new PIN. Ends a lock too. The
 * state lives in the caller, not the form, so it outlasts the keypad: after a wrong code or password the form
 * comes back with the rest kept. `save` sends the new PIN; the caller says what happens next.
 */
export function usePinReset(email?: string) {
  const qc = useQueryClient();
  const [sentTo, setSentTo] = useState<string>();
  // A code went out less than a minute ago, so the server won't send another yet.
  const [recent, setRecent] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ code?: string; password?: string; form?: string }>({});
  // Counts wrong codes; the code field is keyed by it, so a wrong code starts it again empty.
  const [wrongCodes, setWrongCodes] = useState(0);
  const refreshStatus = () => void qc.invalidateQueries({ queryKey: pinStatusQuery.queryKey });

  async function request() {
    setRequesting(true);
    setErrors({});
    try {
      setSentTo((await requestTransactionPinReset()).sentTo);
    } catch (err) {
      if (isApiCode(err, "OTP_COOLDOWN")) {
        setRecent(true);
        setSentTo(email ?? "your email");
      } else {
        if (isApiCode(err, "TRANSACTION_PIN_REQUIRED")) refreshStatus();
        setErrors({ form: friendlyMessage(err) });
      }
    } finally {
      setRequesting(false);
    }
  }

  async function save(newPin: string): Promise<ResetSaved> {
    try {
      qc.setQueryData(pinStatusQuery.queryKey, await resetTransactionPin({ password, code, newPin }));
    } catch (err) {
      if (isApiCode(err, "WEAK_TRANSACTION_PIN")) return { again: friendlyMessage(err) };
      if (isApiCode(err, "INVALID_CODE")) {
        // Cleared for another try, as on the other code screens.
        setCode("");
        setWrongCodes((n) => n + 1);
        setErrors({ code: friendlyMessage(err) });
      } else if (isApiCode(err, "INCORRECT_PASSWORD")) setErrors({ password: friendlyMessage(err) });
      else {
        if (isApiCode(err, "TRANSACTION_PIN_REQUIRED")) refreshStatus();
        setErrors({ form: friendlyMessage(err) });
      }
      return "failed";
    }
    setPassword("");
    return "saved";
  }

  const intro = !sentTo
    ? `We'll email a 6-digit code to ${email ?? "you"}. With the code and your password, you choose a new PIN. Resetting also ends a lock.`
    : `${recent ? `We sent a code to ${sentTo} less than a minute ago.` : `Enter the code we sent to ${sentTo}.`} It expires in 10 minutes.`;

  return { intro, sentTo, requesting, code, password, errors, wrongCodes, setCode, setPassword, setErrors, request, save };
}

/**
 * The reset form for `usePinReset`: "Email me a code", then the code and password. `onChoose` opens the keypad
 * for the new PIN; `cancel` goes under the buttons. The intro (`reset.intro`) is the caller's to place.
 */
export function ResetPinForm({ reset, onChoose, cancel }: { reset: PinReset; onChoose: () => void; cancel: ReactNode }) {
  const passwordField = useRef<TextInputRef>(null);
  const { sentTo, errors, setErrors } = reset;
  const ready = /^\d{6}$/.test(reset.code) && !!reset.password;

  function start() {
    if (!ready) return;
    Keyboard.dismiss();
    setErrors({});
    onChoose();
  }

  if (!sentTo) {
    return (
      <>
        <FormError message={errors.form} />
        <View className="gap-3">
          <Button loading={reset.requesting} onPress={() => void reset.request()}>
            Email me a code
          </Button>
          {cancel}
        </View>
      </>
    );
  }

  return (
    <>
      <FormError message={errors.form ?? errors.code} />
      <CodeField
        key={reset.wrongCodes}
        label="Reset code"
        value={reset.code}
        onChange={(v) => {
          reset.setCode(v);
          setErrors((e) => ({ ...e, code: undefined }));
        }}
        onComplete={() => passwordField.current?.focus()}
        invalid={!!errors.code}
      />
      <PasswordField
        ref={passwordField}
        label="Password"
        value={reset.password}
        onChangeText={(v) => {
          reset.setPassword(v);
          setErrors((e) => ({ ...e, password: undefined }));
        }}
        error={errors.password}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="next"
        onSubmitEditing={start}
      />
      <View className="gap-3">
        <Button disabled={!ready} onPress={start}>
          Choose a new PIN
        </Button>
        <ResendCode onResend={requestTransactionPinReset} />
        {cancel}
      </View>
    </>
  );
}
