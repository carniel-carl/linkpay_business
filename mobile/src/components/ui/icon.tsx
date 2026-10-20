import { SymbolView } from "expo-symbols";
import medium from "expo-symbols/androidWeights/medium";
import type { ComponentProps } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

type Name = Exclude<ComponentProps<typeof SymbolView>["name"], string>;

/** SF Symbols on iOS, Material Symbols on Android: each platform's own icon language. Decorative by default. */
export function Icon({
  ios,
  android,
  size = 22,
  color,
  style,
  label,
}: {
  ios: NonNullable<Name["ios"]>;
  android: NonNullable<Name["android"]>;
  size?: number;
  color: ColorValue;
  style?: StyleProp<ViewStyle>;
  /** Give a label only when the icon carries meaning on its own. */
  label?: string;
}) {
  return (
    <SymbolView
      name={{ ios, android }}
      size={size}
      tintColor={color}
      weight={{ ios: "medium", android: medium }}
      style={[{ width: size, height: size }, style]}
      accessible={!!label}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
    />
  );
}
