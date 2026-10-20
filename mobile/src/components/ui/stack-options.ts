import type { Palette } from "@/theme/tokens";

/**
 * Native stack headers inside the app (More, Payments, Home's detail screens): paper, no hairline, inline
 * titles. Large titles stay off: inside NativeTabs on iOS 26 they reserve their height but never draw the title.
 */
export const stackScreenOptions = (colors: Palette) =>
  ({
    headerLargeTitle: false,
    headerLargeTitleShadowVisible: false,
    headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.foreground },
    headerLargeTitleStyle: { fontFamily: "BricolageDisplay-SemiBold", color: colors.foreground },
    headerBackButtonDisplayMode: "minimal",
    contentStyle: { backgroundColor: colors.background },
  }) as const;
