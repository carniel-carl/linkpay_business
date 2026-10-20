import { OTPInput, type OTPInputRef, type SlotProps } from "input-otp-native";
import { forwardRef, useEffect } from "react";
import { Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { cn } from "@/lib/cn";

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  invalid?: boolean;
  disabled?: boolean;
};

/** Six digit slots. Accepts paste and the code the keyboard suggests from Mail or Messages. */
export const CodeField = forwardRef<OTPInputRef, Props>(function CodeField(
  { label, value, onChange, onComplete, invalid, disabled },
  ref,
) {
  return (
    <View className="gap-2">
      <Text className="text-[14px] font-medium text-foreground">{label}</Text>
      <OTPInput
        ref={ref}
        value={value}
        onChange={onChange}
        onComplete={onComplete}
        maxLength={6}
        autoFocus
        editable={!disabled}
        accessibilityLabel={`${label}, 6 digits`}
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        render={({ slots }) => (
          <View className="flex-row justify-between gap-2">
            {slots.map((slot, i) => (
              <Slot key={i} {...slot} invalid={invalid} />
            ))}
          </View>
        )}
      />
    </View>
  );
});

function Slot({ char, isActive, hasFakeCaret, invalid }: SlotProps & { invalid?: boolean }) {
  return (
    <View
      className={cn(
        "h-14 flex-1 items-center justify-center rounded-field border-[1.5px] bg-card",
        invalid ? "border-destructive" : isActive ? "border-ring" : "border-input",
      )}
    >
      {char ? (
        <Text className="text-foreground" style={{ fontFamily: "BricolageText-SemiBold", fontSize: 22 }}>
          {char}
        </Text>
      ) : hasFakeCaret ? (
        <Caret />
      ) : null}
    </View>
  );
}

function Caret() {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withRepeat(withSequence(withTiming(0, { duration: 500 }), withTiming(1, { duration: 500 })), -1));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={style} className="h-6 w-[2px] rounded-full bg-foreground" />;
}
