import { router } from "expo-router";
import { Alert } from "react-native";
import { BandScreen } from "@/components/security/band-screen";
import { CreatePasscode } from "@/components/security/create-passcode";
import { TextButton } from "@/components/ui/button";
import { setUnlocked } from "@/lib/auth/session";
import { useAuth } from "@/lib/auth/store";
import { getBiometry } from "@/lib/security/biometrics";
import { setPasscode } from "@/lib/security/passcode";

export default function SetPasscode() {
  const { passcodeReady, signOut } = useAuth();

  async function created(code: string) {
    await setPasscode(code);
    // The owner just chose the passcode, so requests can go: the Face ID step asks the server for a sign-in key.
    setUnlocked(true);
    const biometry = await getBiometry();
    if (biometry.available) router.replace("/biometrics");
    else passcodeReady();
  }

  return (
    <BandScreen sheet topOffset={16}>
      <CreatePasscode
        onCreated={created}
        footer={
          <TextButton
            tone="band"
            onPress={() =>
              Alert.alert("Sign out?", "You'll need to sign in again to use LinkPay Business on this phone.", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign out", style: "destructive", onPress: () => void signOut("signedOut") },
              ])
            }
          >
            Sign out instead
          </TextButton>
        }
      />
    </BandScreen>
  );
}
