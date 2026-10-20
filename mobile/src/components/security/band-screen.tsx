import { FocusStatusBar } from "@/components/ui/status-bar";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** A full navy field for passcode and lock moments, inside the safe area. */
export function BandScreen({ children, topOffset = 40 }: { children: ReactNode; topOffset?: number }) {
  return (
    <SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-band">
      <FocusStatusBar style="light" />
      <View style={{ paddingTop: topOffset, paddingBottom: 8 }} className="flex-1">
        {children}
      </View>
    </SafeAreaView>
  );
}
