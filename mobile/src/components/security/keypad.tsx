import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "@/components/ui/icon";

const ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]];

function Key({ onPress, label, children, disabled }: { onPress: () => void; label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={cn("h-[72px] w-[72px] items-center justify-center rounded-full active:bg-band-raised", disabled && "opacity-40")}
    >
      {children}
    </Pressable>
  );
}

/**
 * The app's own number pad. Passcodes never go through the system keyboard, so third-party keyboards
 * and keyboard caches never see them.
 */
export function Keypad({
  onDigit,
  onDelete,
  biometric,
  disabled,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
  biometric?: { label: string; kind: "face" | "fingerprint" | "other"; onPress: () => void };
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const digit = (d: string) => (
    <Key key={d} label={d} onPress={() => onDigit(d)} disabled={disabled}>
      <Text allowFontScaling={false} className="text-band-foreground" style={{ fontFamily: "BricolageText-Medium", fontSize: 28 }}>
        {d}
      </Text>
    </Key>
  );
  return (
    <View className="gap-3 self-center">
      {ROWS.map((row) => (
        <View key={row[0]} className="flex-row gap-6">
          {row.map(digit)}
        </View>
      ))}
      <View className="flex-row gap-6">
        {biometric ? (
          <Key label={`Unlock with ${biometric.label}`} onPress={biometric.onPress} disabled={disabled}>
            <Icon
              ios={biometric.kind === "face" ? "faceid" : "touchid"}
              android={biometric.kind === "face" ? "face" : "fingerprint"}
              color={colors["band-foreground"]}
              size={30}
            />
          </Key>
        ) : (
          <View className="h-[72px] w-[72px]" />
        )}
        {digit("0")}
        <Key label="Delete" onPress={onDelete} disabled={disabled}>
          <Icon ios="delete.left" android="backspace" color={colors["band-foreground"]} size={26} />
        </Key>
      </View>
    </View>
  );
}
