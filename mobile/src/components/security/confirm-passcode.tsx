import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TextButton } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/store";
import { MAX_ATTEMPTS, verifyPasscode } from "@/lib/security/passcode";
import { PasscodeEntry, type EntryResult } from "./passcode-entry";

/**
 * Asks for the app passcode before something that moves money. Wrong entries count toward the same
 * limit as the lock screen: the last one signs the phone out. A native modal, so it covers the header
 * and tab bar too; it shows nothing but the keypad, so it may sit above the lock screen.
 */
export function ConfirmPasscode({ title, subtitle, onConfirmed, onCancel }: { title: string; subtitle?: string; onConfirmed: () => void; onCancel: () => void }) {
  const signOut = useAuth((s) => s.signOut);
  const [message, setMessage] = useState<string>();

  async function check(code: string): Promise<EntryResult> {
    const result = await verifyPasscode(code);
    if (result.ok) {
      onConfirmed();
      return "ok";
    }
    if (result.attemptsLeft === 0) {
      await signOut("tooManyAttempts");
      return "error";
    }
    setMessage(
      result.attemptsLeft === 1
        ? "Wrong passcode. One more wrong try signs this phone out."
        : `Wrong passcode. ${result.attemptsLeft} of ${MAX_ATTEMPTS} tries left.`,
    );
    return "error";
  }

  return (
    <Modal visible animationType="fade" onRequestClose={onCancel} statusBarTranslucent navigationBarTranslucent>
      <View className="flex-1 bg-band">
      <StatusBar style="light" />
      <SafeAreaView edges={["top"]} style={{ flex: 1, paddingTop: 16 }}>
        <PasscodeEntry
          title={title}
          subtitle={subtitle}
          message={message}
          onComplete={check}
          footer={
            <TextButton tone="band" onPress={onCancel}>
              Cancel
            </TextButton>
          }
        />
      </SafeAreaView>
      </View>
    </Modal>
  );
}
