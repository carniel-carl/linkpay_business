import { View } from "react-native";
import { LogoTile } from "@/components/brand/logo";

/** Shown whenever the app isn't in the foreground, so the app switcher never shows balances or codes. */
export function PrivacyCover() {
  return (
    <View pointerEvents="none" className="absolute inset-0 items-center justify-center bg-band">
      <LogoTile size={64} />
    </View>
  );
}
