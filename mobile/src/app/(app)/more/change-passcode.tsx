import { router } from "expo-router";
import { useState } from "react";
import { BandScreen } from "@/components/security/band-screen";
import { CreatePasscode } from "@/components/security/create-passcode";
import { PasscodeEntry, type EntryResult } from "@/components/security/passcode-entry";
import { useAuth } from "@/lib/auth/store";
import { setPasscode, verifyPasscode } from "@/lib/security/passcode";

export default function ChangePasscode() {
  const signOut = useAuth((s) => s.signOut);
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState<string>();

  async function checkCurrent(code: string): Promise<EntryResult> {
    const result = await verifyPasscode(code);
    if (result.ok) {
      setVerified(true);
      return "keep";
    }
    if (result.attemptsLeft === 0) {
      await signOut("tooManyAttempts");
      return "error";
    }
    setMessage(`That isn't your current passcode. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`);
    return "error";
  }

  return (
    <BandScreen topOffset={56}>
      {verified ? (
        <CreatePasscode
          title="Choose a new passcode"
          subtitle="Four digits you haven't used before."
          onCreated={async (code) => {
            await setPasscode(code);
            router.back();
          }}
        />
      ) : (
        <PasscodeEntry title="Enter your current passcode" message={message} onComplete={checkCurrent} />
      )}
    </BandScreen>
  );
}
