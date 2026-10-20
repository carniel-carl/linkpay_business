import * as Haptics from "expo-haptics";
import { Children, Fragment, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

/** A labelled card of choices: role cards, branch checkboxes. */
export function OptionList({ label, hint, error, children }: { label?: string; hint?: string; error?: string; children: ReactNode }) {
  const { shadows } = useTheme();
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View className="gap-2">
      {label && <Text className="text-[14px] font-medium text-foreground">{label}</Text>}
      <View
        style={{ boxShadow: shadows.surface }}
        className={cn("overflow-hidden rounded-surface bg-card", error && "border-[1.5px] border-destructive")}
      >
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 && <View className="ml-4 h-px bg-border" />}
            {child}
          </Fragment>
        ))}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-[13px] leading-[18px] text-destructive-foreground">
          {error}
        </Text>
      ) : hint ? (
        <Text className="text-[13px] leading-[18px] text-muted-foreground">{hint}</Text>
      ) : null}
    </View>
  );
}

/** One choice: a radio (pick one) or a checkbox (pick any). The whole row is the touch target. */
export function OptionRow({
  title,
  detail,
  selected,
  onPress,
  kind = "radio",
  disabled,
}: {
  title: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
  kind?: "radio" | "check";
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={kind === "radio" ? "radio" : "checkbox"}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={cn("min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-muted", disabled && "opacity-50")}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-medium text-foreground">{title}</Text>
        {detail && <Text className="text-[13px] leading-[18px] text-muted-foreground">{detail}</Text>}
      </View>
      {kind === "radio" ? (
        <View className={cn("h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px]", selected ? "border-primary" : "border-input")}>
          {selected && <View className="h-3 w-3 rounded-full bg-primary" />}
        </View>
      ) : (
        <View className={cn("h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[1.5px]", selected ? "border-primary bg-primary" : "border-input")}>
          {selected && <Icon ios="checkmark" android="check" size={14} color={colors["primary-foreground"]} />}
        </View>
      )}
    </Pressable>
  );
}
