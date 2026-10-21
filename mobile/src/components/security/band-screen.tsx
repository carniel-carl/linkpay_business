import { FocusStatusBar } from "@/components/ui/status-bar";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/**
 * A full navy field for passcode and lock moments, inside the safe area. `sheet` leaves the bottom edge
 * to the passcode sheet, which pads for the home indicator itself.
 */
export function BandScreen({ children, topOffset = 40, sheet = false }: { children: ReactNode; topOffset?: number; sheet?: boolean }) {
  return (
    <SafeAreaView edges={sheet ? ["top"] : ["top", "bottom"]} className="flex-1 bg-band">
      <FocusStatusBar style="light" />
      <View style={{ paddingTop: topOffset, paddingBottom: sheet ? 0 : 8 }} className="flex-1">
        {children}
      </View>
    </SafeAreaView>
  );
}
