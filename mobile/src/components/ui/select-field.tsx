import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";
import { OptionList, OptionRow } from "./options";

/**
 * A field that opens its choices in place, underneath it (industry, ID type). Picking one closes the list.
 * No sheet or menu: those draw above the lock screen.
 */
export function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
  error,
  hint,
}: {
  label: string;
  value?: string;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View className="gap-2">
      <Text maxFontSizeMultiplier={1.4} className="text-[14px] font-medium text-foreground">
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? "not chosen"}`}
        accessibilityState={{ expanded: open }}
        accessibilityHint={error}
        onPress={() => setOpen((o) => !o)}
        className={cn(
          "min-h-[50px] flex-row items-center gap-3 rounded-field border-[1.5px] bg-card px-4 active:opacity-80",
          error ? "border-destructive" : open ? "border-ring" : "border-input",
        )}
      >
        <Text maxFontSizeMultiplier={1.4} className={cn("flex-1 text-[16px]", current ? "text-foreground" : "text-muted-foreground")}>
          {current?.label ?? placeholder}
        </Text>
        <Icon ios={open ? "chevron.up" : "chevron.down"} android={open ? "expand_less" : "expand_more"} size={15} color={colors["muted-foreground"]} />
      </Pressable>
      {open && (
        <OptionList>
          {options.map((o) => (
            <OptionRow
              key={o.value}
              title={o.label}
              selected={o.value === value}
              onPress={() => {
                setOpen(false);
                onChange(o.value);
              }}
            />
          ))}
        </OptionList>
      )}
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
