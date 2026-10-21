import { Image } from "expo-image";
import { Text, View } from "react-native";
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
      <Image
        source={mark}
        contentFit="contain"
        tintColor={colors["pop-foreground"]}
        style={{ width, height: width / MARK_ASPECT }}
      />
    </View>
  );
}

/** "Business" next to "linkPay", as a share of its size. Matches the web and admin logos (0.62em). */
export const PRODUCT_SCALE = 0.62;

const TONES = {
  page: { name: "text-foreground", product: "text-muted-foreground" },
  /** The entrance's navy band. */
  band: { name: "text-band-foreground", product: "text-band-muted" },
  /** The dashboard band (Home): pale in light, deep navy in dark. */
  surface: { name: "text-brand-surface-foreground", product: "text-brand-surface-muted" },
} as const;

/** Tile and wordmark. `onBand` for the entrance's navy; `tone="surface"` for the Home band. */
export function Logo({
  onBand = false,
  tone = onBand ? "band" : "page",
  showProduct = true,
  size = 34,
}: {
  onBand?: boolean;
  tone?: keyof typeof TONES;
  showProduct?: boolean;
  /** Tile size; the wordmark scales with it. */
  size?: number;
}) {
  const t = TONES[tone];
  const fontSize = Math.round(size * 0.53);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="LinkPay Business"
      className="flex-row items-center"
      style={{ gap: size * 0.28 }}
    >
      <LogoTile size={size} />
      <Text
        maxFontSizeMultiplier={1.2}
        className={t.name}
        style={{ fontFamily: "BricolageDisplay-SemiBold", fontSize, letterSpacing: -0.02 * fontSize }}
      >
        linkPay
        {showProduct && (
          // Much smaller on the same baseline: LinkPay's business product, not a separate brand.
          <Text style={{ fontFamily: "BricolageDisplay-Medium", fontSize: Math.round(fontSize * PRODUCT_SCALE), letterSpacing: 0 }} className={t.product}>
            {"  "}Business
          </Text>
        )}
      </Text>
    </View>
  );
}
