import { router, useNavigation } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogoTile } from "@/components/brand/logo";
import { Icon } from "@/components/ui/icon";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { Display } from "@/components/ui/typography";
import { SchemeScope, useTheme } from "@/theme/theme";

/**
 * The auth frame on a phone: one navy field, continuous with the welcome and lock screens, in both
 * appearances. The form inside uses the dark palette (raised navy fields, lime primary), and the
 * content scrolls above the keyboard.
 */
export function AuthScreen({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  // The navy of the surrounding appearance, so auth matches the welcome screen exactly.
  const { colors } = useTheme();
  return (
    <SchemeScope scheme="dark" style={{ backgroundColor: colors.band }}>
      <FocusStatusBar style="light" />
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
      >
        {/* One navigation row: back on the leading edge, the brand tile centred, an equal spacer trailing. */}
        <View className="h-11 flex-row items-center justify-between">
          <View className="w-11">
            {/* A screen opened from a link has no history: Back then goes to the welcome screen. */}
            <BackButton onPress={() => (navigation.canGoBack() ? router.back() : router.replace("/"))} />
          </View>
          <LogoTile size={32} />
          <View className="w-11" />
        </View>
        <View className="gap-2.5 pb-7 pt-9">
          <Display size={26}>{title}</Display>
          {typeof description === "string" ? (
            <Text className="text-[15px] leading-[22px] text-muted-foreground">{description}</Text>
          ) : (
            description
          )}
        </View>
        <View className="gap-5">{children}</View>
        {footer && <View className="mt-auto pt-10">{footer}</View>}
      </KeyboardAwareScrollView>
    </SchemeScope>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onPress}
      hitSlop={8}
      className="h-11 w-11 items-center justify-center rounded-full bg-card active:opacity-70"
    >
      <Icon ios="chevron.left" android="arrow_back" size={18} color={colors.foreground} />
    </Pressable>
  );
}

/** "New to LinkPay? Open an account" style line under a form. */
export function FooterPrompt({ text, children }: { text: string; children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-x-1.5">
      <Text className="text-[14px] text-muted-foreground">{text}</Text>
      {children}
    </View>
  );
}

/** Inline emphasis inside a description, e.g. the email a code was sent to. */
export function Strong({ children }: { children: ReactNode }) {
  return <Text className="font-semibold text-foreground">{children}</Text>;
}
