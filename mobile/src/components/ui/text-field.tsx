import { forwardRef, useState, type ComponentRef, type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/theme";
import { Icon } from "./icon";

export type TextInputRef = ComponentRef<typeof TextInput>;

type Props = TextInputProps & { label: string; error?: string; hint?: string; trailing?: ReactNode };

/** Label above, helper or error below. The border carries focus and error state; its width never changes. */
export const TextField = forwardRef<TextInputRef, Props>(function TextField(
  { label, error, hint, trailing, onFocus, onBlur, editable = true, ...props },
  ref,
) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View className="gap-2">
      <Text maxFontSizeMultiplier={1.4} className="text-[14px] font-medium text-foreground">
        {label}
      </Text>
      <View
        className={cn(
          "min-h-[50px] flex-row items-center rounded-field border-[1.5px] bg-card",
          error ? "border-destructive" : focused ? "border-ring" : "border-input",
          !editable && "opacity-60",
        )}
      >
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          editable={editable}
          placeholderTextColor={colors["muted-foreground"]}
          selectionColor={colors.ring}
          cursorColor={colors.ring}
          maxFontSizeMultiplier={1.4}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          className="min-h-[50px] flex-1 px-4 text-[16px] text-foreground"
          {...props}
        />
        {trailing}
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
});

export const PasswordField = forwardRef<TextInputRef, Omit<Props, "secureTextEntry" | "trailing">>(function PasswordField(
  props,
  ref,
) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      ref={ref}
      secureTextEntry={!visible}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? "Hide password" : "Show password"}
          onPress={() => setVisible((v) => !v)}
          hitSlop={8}
          className="h-[50px] w-12 items-center justify-center active:opacity-60"
        >
          <Icon
            ios={visible ? "eye.slash" : "eye"}
            android={visible ? "visibility_off" : "visibility"}
            color={colors["muted-foreground"]}
            size={20}
          />
        </Pressable>
      }
      {...props}
    />
  );
});
