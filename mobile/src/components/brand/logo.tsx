import { Image } from "expo-image";
import { Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";

// The LinkPay bridge in white, tinted at runtime. Rendered by web/scripts/brand-assets.ts.
const mark = require("@/assets/images/logo-mark.png");
const MARK_ASPECT = 374 / 144;
// Share of the tile the mark spans; the app icon and native splash use the same ratio.
const MARK_WIDTH = 0.58;

/** The lime tile with the ink LinkPay bridge, as on the app icon and splash. */
export function LogoTile({ size = 40 }: { size?: number }) {
  const { colors } = useTheme();
  const width = size * MARK_WIDTH;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center bg-pop"
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
    >
      <Image source={mark} contentFit="contain" tintColor={colors["pop-foreground"]} style={{ width, height: width / MARK_ASPECT }} />
    </View>
  );
}

/** Tile and wordmark. `onBand` for navy surfaces. */
export function Logo({ onBand = false, showProduct = true }: { onBand?: boolean; showProduct?: boolean }) {
  return (
    <View accessible accessibilityLabel="LinkPay Business" className="flex-row items-center gap-2.5">
      <LogoTile size={34} />
      <Text
        maxFontSizeMultiplier={1.2}
        className={cn(onBand ? "text-band-foreground" : "text-foreground")}
        style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize: 18, letterSpacing: -0.36 }}
      >
        linkPay
        {showProduct && (
          <Text style={{ fontFamily: "BricolageDisplay-Medium" }} className={onBand ? "text-band-muted" : "text-muted-foreground"}>
            {" "}
            Business
          </Text>
        )}
      </Text>
    </View>
  );
}
