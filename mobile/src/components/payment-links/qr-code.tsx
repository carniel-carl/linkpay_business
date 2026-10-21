import { Image, type ImageSource } from "expo-image";
import QRCode from "qrcode";
import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { useTheme } from "@/theme/theme";

/** Modules of quiet zone around the code; scanners need at least 4. */
const QUIET = 4;
/** The logo plate covers this share of the code's width. Level H recovers 30% damage, so this stays well clear. */
const LOGO_SHARE = 0.22;

/**
 * A QR code drawn as one SVG path, on white with its quiet zone. With a logo it uses the highest error
 * correction and puts the logo on a white plate in the middle (same layout as the web's link-qr.tsx).
 */
export function QrCode({ value, size, color, logo }: { value: string; size: number; color: string; logo?: ImageSource }) {
  const { colors } = useTheme();
  // Codes are dark on white in both appearances: scanners and printers expect it.
  const paper = colors.paper;
  const withLogo = !!logo;
  const { total, path, plate } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: withLogo ? "H" : "M" });
    let d = "";
    for (let r = 0; r < modules.size; r++) {
      for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
    let plateSize = Math.ceil(modules.size * LOGO_SHARE);
    if ((modules.size - plateSize) % 2) plateSize += 1;
    return { total: modules.size + QUIET * 2, path: d, plate: { start: (modules.size - plateSize) / 2 + QUIET, size: plateSize } };
  }, [value, withLogo]);

  // Whole points per module, so neighbouring squares meet without anti-aliased seams. Never larger than `size`.
  const px = Math.max(1, Math.floor(size / total));
  const drawn = px * total;
  return (
    <View style={{ width: drawn, height: drawn }}>
      <Svg width={drawn} height={drawn} viewBox={`0 0 ${total} ${total}`}>
        <Rect width={total} height={total} fill={paper} />
        <Path d={path} fill={color} />
      </Svg>
      {logo && (
        <View
          style={{
            position: "absolute",
            left: plate.start * px,
            top: plate.start * px,
            width: plate.size * px,
            height: plate.size * px,
            padding: plate.size * px * 0.12,
            borderRadius: plate.size * px * 0.22,
            borderCurve: "continuous",
            backgroundColor: paper,
          }}
        >
          <Image source={logo} contentFit="contain" style={{ flex: 1 }} accessibilityIgnoresInvertColors />
        </View>
      )}
    </View>
  );
}
