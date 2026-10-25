import * as Haptics from "expo-haptics";
import type { ComponentProps, ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { cn } from "@/lib/cn";
import { suspendedHint, useWriteGuard } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";
import type { TokenName } from "@/theme/tokens";
import { Icon } from "./icon";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const VARIANTS = {
  primary: { box: "bg-primary", text: "text-primary-foreground", spinner: "primary-foreground" },
  /** Lime, for the main action on a navy band. */
  pop: { box: "bg-pop", text: "text-pop-foreground", spinner: "pop-foreground" },
  outline: { box: "border border-input bg-card", text: "text-foreground", spinner: "foreground" },
  /** Secondary action on a navy band. */
  band: { box: "border border-band-muted/40", text: "text-band-foreground", spinner: "band-foreground" },
  ghost: { box: "", text: "text-primary", spinner: "primary" },
  destructive: { box: "bg-destructive-subtle", text: "text-destructive-foreground", spinner: "destructive-foreground" },
} satisfies Record<string, { box: string; text: string; spinner: TokenName }>;

const SIZES = { lg: "h-[50px] px-6", md: "h-11 px-5", sm: "h-9 px-4" };

type Props = Omit<PressableProps, "children"> & {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
  /** Drawn in the label's colour, so icon and text always match the variant (and the scheme in scope). */
  icon?: Pick<ComponentProps<typeof Icon>, "ios" | "android">;
  className?: string;
  /**
   * The press changes the business (or opens a screen that does). While the business is suspended it stays visible
   * and tappable, even if it would otherwise be disabled, and a tap explains why it can't go ahead, with a way to
   * email support (useWriteGuard), instead of running.
   */
  write?: boolean;
};

/** Pill button. Presses scale to 0.98, like the web's buttons, with a light haptic tap. */
export function Button({
  children,
  variant = "primary",
  size = "lg",
  loading,
  disabled,
  icon,
  className,
  onPress,
  write,
  accessibilityHint,
  ...props
}: Props) {
  const { colors } = useTheme();
  const writes = useWriteGuard();
  const blocked = !!write && !!writes.suspended;
  const v = VARIANTS[variant];
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const inactive = blocked ? loading : disabled || loading;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      accessibilityHint={blocked ? suspendedHint(writes.suspended!) : accessibilityHint}
      disabled={inactive}
      onPressIn={() => scale.set(withTiming(0.98, { duration: 90 }))}
      onPressOut={() => scale.set(withSpring(1, { damping: 18, stiffness: 320 }))}
      onPress={(e) => {
        if (blocked) return void writes.allow();
        if (variant === "primary" || variant === "pop") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(e);
      }}
      style={animated}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full",
        SIZES[size],
        v.box,
        inactive && !loading && "opacity-50",
        className,
      )}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={colors[v.spinner]} />
      ) : (
        icon && <Icon {...icon} size={19} color={colors[v.spinner]} />
      )}
      {typeof children === "string" ? (
        <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className={cn("text-[15px] font-semibold", v.text)}>
          {children}
        </Text>
      ) : (
        children
      )}
    </AnimatedPressable>
  );
}

/** Inline text action (links, "Resend code"). Keeps a 44pt touch area. `write` as on Button. */
export function TextButton({
  children,
  onPress,
  disabled,
  tone = "primary",
  className,
  write,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "band" | "muted";
  className?: string;
  write?: boolean;
}) {
  const writes = useWriteGuard();
  const blocked = !!write && !!writes.suspended;
  const inactive = !blocked && !!disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      accessibilityHint={blocked ? suspendedHint(writes.suspended!) : undefined}
      disabled={inactive}
      onPress={blocked ? () => void writes.allow() : onPress}
      hitSlop={12}
      className={cn("min-h-11 justify-center active:opacity-60", inactive && "opacity-50", className)}
    >
      <Text
        className={cn(
          "text-[14px] font-semibold",
          tone === "primary" && "text-primary",
          tone === "band" && "text-band-foreground",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {children}
      </Text>
    </Pressable>
  );
}
