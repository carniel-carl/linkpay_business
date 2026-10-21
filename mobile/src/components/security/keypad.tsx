import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "@/components/ui/icon";

const ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]];

/** A bare key: no fill or outline at rest, a soft round highlight only while pressed. */
function Key({
  onPress,
  label,
  children,
  disabled,
  height,
}: {
  onPress: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
  height: number;
}) {
  return (
    <View className="flex-1 items-center justify-center" style={{ height }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={() => {
          void Haptics.selectionAsync();
          onPress();
        }}
        className={cn("items-center justify-center rounded-full active:bg-band-raised", disabled && "opacity-40")}
        style={{ width: height + 8, height }}
      >
        {children}
      </Pressable>
    </View>
  );
}

/**
 * The app's own number pad, drawn on the navy band. Passcodes never go through the system keyboard,
 * so third-party keyboards and keyboard caches never see them.
 */
export function Keypad({
  onDigit,
  onDelete,
  biometric,
  disabled,
  keyHeight = 72,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
  biometric?: { label: string; kind: "face" | "fingerprint" | "other"; onPress: () => void };
  disabled?: boolean;
  keyHeight?: number;
}) {
  const { colors } = useTheme();
  const digit = (d: string) => (
    <Key key={d} label={d} height={keyHeight} onPress={() => onDigit(d)} disabled={disabled}>
      <Text
        allowFontScaling={false}
        className="text-band-foreground"
        style={{ fontFamily: "BricolageDisplay-Medium", fontSize: 34, letterSpacing: -0.9, fontVariant: ["tabular-nums"] }}
      >
        {d}
      </Text>
    </Key>
  );
  return (
    <View>
      {ROWS.map((row) => (
        <View key={row[0]} className="flex-row">
          {row.map(digit)}
        </View>
      ))}
      <View className="flex-row">
        {biometric ? (
          <Key label={`Unlock with ${biometric.label}`} height={keyHeight} onPress={biometric.onPress} disabled={disabled}>
            <Icon
              ios={biometric.kind === "face" ? "faceid" : "touchid"}
              android={biometric.kind === "face" ? "face" : "fingerprint"}
              color={colors.pop}
              size={30}
            />
          </Key>
        ) : (
          <View className="flex-1" />
        )}
        {digit("0")}
        <Key label="Delete" height={keyHeight} onPress={onDelete} disabled={disabled}>
          <Icon ios="delete.left" android="backspace" color={colors["band-foreground"]} size={26} />
        </Key>
      </View>
    </View>
  );
}
