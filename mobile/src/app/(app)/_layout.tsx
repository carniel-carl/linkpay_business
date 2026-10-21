import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { useTheme } from "@/theme/theme";

/**
 * Native tab bar (UITabBar on iOS, Material navigation bar on Android): Home, Payments, Invoices, Team, More.
 * iOS keeps its system glass, which follows the app's appearance; Android would otherwise take Material You
 * wallpaper colours, so it gets the app's own.
 */
export default function AppTabs() {
  const { colors } = useTheme();
  return (
    <NativeTabs
      tintColor={colors.primary}
      labelStyle={{ selected: { color: colors.primary } }}
      {...(Platform.OS === "android" && {
        backgroundColor: colors.card,
        iconColor: colors["muted-foreground"],
        indicatorColor: colors["brand-subtle"],
        rippleColor: colors.muted,
      })}
    >
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="payments">
        <NativeTabs.Trigger.Label>Payments</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "arrow.down.circle", selected: "arrow.down.circle.fill" }} md="south_west" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="invoices">
        <NativeTabs.Trigger.Label>Invoices</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "doc.text", selected: "doc.text.fill" }} md="receipt_long" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="team">
        <NativeTabs.Trigger.Label>Team</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "person.2", selected: "person.2.fill" }} md="group" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
