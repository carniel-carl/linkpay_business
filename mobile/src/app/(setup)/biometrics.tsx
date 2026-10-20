import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { BandScreen } from "@/components/security/band-screen";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAuth } from "@/lib/auth/store";
import { capitalized, getBiometry, type Biometry } from "@/lib/security/biometrics";
import { useTheme } from "@/theme/theme";

export default function EnableBiometrics() {
  const { colors } = useTheme();
  const { passcodeReady, updateBiometrics } = useAuth();
  const [biometry, setBiometry] = useState<Biometry>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getBiometry().then(setBiometry);
  }, []);

  async function enable() {
    if (!biometry) return;
    setBusy(true);
    // One confirmation turns on both. Offline, the server can't issue the sign-in key: unlock alone still
    // works, and sign-in can be turned on later under More.
    const prompt = `Use ${biometry.label} for LinkPay Business`;
    let result = await updateBiometrics({ unlock: true, signIn: true }, prompt);
    if (!result.ok && result.message) result = await updateBiometrics({ unlock: true, signIn: false }, prompt);
    setBusy(false);
    if (result.ok) passcodeReady();
  }

  const label = biometry?.label ?? "biometrics";
  const Label = capitalized(label);

  return (
    <BandScreen topOffset={96}>
      <View className="flex-1 items-center gap-5 px-8">
        <View className="h-24 w-24 items-center justify-center rounded-[30px] bg-band-raised">
          <Icon
            ios={biometry?.kind === "face" ? "faceid" : "touchid"}
            android={biometry?.kind === "face" ? "face" : "fingerprint"}
            color={colors.pop}
            size={52}
          />
        </View>
        <Text
          accessibilityRole="header"
          className="text-center text-band-foreground"
          style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: 26, letterSpacing: -0.91, lineHeight: 29 }}
        >
          Use {label}?
        </Text>
        <Text className="text-center text-[15px] leading-[22px] text-band-muted">
          Open the app with {label} instead of your passcode, and sign back in with it after you sign out. Your passcode and
          password still work if {label} doesn't.
        </Text>
      </View>
      <View className="gap-3 px-6 pb-2">
        <Button variant="pop" loading={busy} onPress={enable}>
          {`Use ${Label}`}
        </Button>
        <Button variant="band" onPress={passcodeReady}>
          Not now
        </Button>
      </View>
    </BandScreen>
  );
}
