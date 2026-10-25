import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { BusinessClosed } from "@/components/home/business-closed";
import { useOverview } from "@/lib/api/banking";
import { isOwner } from "@/lib/permissions";
import { useRecoveryCodesOnScreen } from "@/lib/recovery-codes";
import { restrictionOf, SuspendedContext, useRestrictionSync } from "@/lib/restriction";
import { useTheme } from "@/theme/theme";

/**
 * Native tab bar (UITabBar on iOS, Material navigation bar on Android): Home, Payments, Invoices, Team, More.
 * iOS keeps its system glass, which follows the app's appearance; Android would otherwise take Material You
 * wallpaper colours, so it gets the app's own.
 *
 * A business compliance has closed gets the closed screen over the tabs instead (every business request is refused);
 * a suspended one keeps the tabs, with Home's banner, and every action that changes it explains instead of running
 * (SuspendedContext and useWriteGuard in lib/restriction.ts).
 */
export default function AppTabs() {
  const { colors } = useTheme();
  const overview = useOverview();
  const restriction = restrictionOf(overview.data);
  useRestrictionSync(restriction !== "active");
  // New recovery codes are shown once, on More's Security and Authenticator screens: tapping More again mustn't pop them.
  const codesOnScreen = useRecoveryCodesOnScreen((s) => s.shown);

  return (
    <SuspendedContext value={restriction === "suspended" && overview.data ? overview.data.business.name : null}>
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
          <NativeTabs.Trigger.Icon
            sf={{ default: "arrow.down.circle", selected: "arrow.down.circle.fill" }}
            md="south_west"
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="invoices">
          <NativeTabs.Trigger.Label>Invoices</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: "doc.text", selected: "doc.text.fill" }} md="receipt_long" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="team">
          <NativeTabs.Trigger.Label>Team</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: "person.2", selected: "person.2.fill" }} md="group" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="more" disablePopToTop={codesOnScreen}>
          <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
        </NativeTabs.Trigger>
      </NativeTabs>
      {restriction === "banned" && overview.data && (
        <BusinessClosed
          businessId={overview.data.business._id}
          name={overview.data.business.name}
          // The owner can't leave (OWNER_CANNOT_LEAVE); any other member can, though the business is closed.
          canLeave={!!overview.data.membership && !isOwner(overview.data.membership)}
        />
      )}
    </SuspendedContext>
  );
}
