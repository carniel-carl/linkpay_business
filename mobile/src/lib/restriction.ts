// Compliance restrictions on a business (docs/briefs/compliance.md §6). The business is told that it's restricted,
// never why. Suspended: every read works and every change is refused (BUSINESS_SUSPENDED), so Home shows a banner and
// every action that changes the business explains instead of running (useWriteGuard). Banned, shown as "Closed": every
// business route is refused (BUSINESS_BANNED), so the closed screen covers the tabs.
import { createContext, useContext, useEffect, useMemo } from "react";
import { Alert, AppState, Linking } from "react-native";
import { ApiError } from "@/lib/api/errors";
import type { MembershipSummary, Overview, RestrictionStatus } from "@/lib/api/types";
import { useBusinessContext } from "@/lib/business-context";
import { SUPPORT_EMAIL } from "@/lib/config";
import { queryClient } from "@/lib/query";

/**
 * Writes to support from the suspended banner or the closed screen. A phone with no mail app set up refuses mailto
 * links, so it then says where to write instead of doing nothing.
 */
export function emailSupport(subject: string) {
  Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`).catch(() =>
    Alert.alert("Email support", `There's no email app set up on this phone. Write to ${SUPPORT_EMAIL} from any email account.`),
  );
}

export const restrictionOf = (overview: Pick<Overview, "business"> | undefined): RestrictionStatus =>
  overview?.business.restriction?.status ?? "active";

/** Why a change can't be made, the same sentence as the web's disabled actions. */
export const suspendedHint = (businessName: string) => `${businessName} is suspended, so you can't do this right now.`;

/** What tapping a change says while the business is suspended, with a way to write to support. */
export function alertSuspended(businessName: string) {
  Alert.alert(suspendedHint(businessName), "You can still see your balances and payments.", [
    { text: "OK", style: "cancel" },
    { text: "Email support", onPress: () => emailSupport(`Suspended business: ${businessName}`) },
  ]);
}

/**
 * The suspended business's name, or null while changes are allowed. Set once by the (app) layout from the overview,
 * so the shared Button and rows can read it without a query of their own (they're used on sign-in screens too).
 */
export const SuspendedContext = createContext<string | null>(null);

/**
 * For every action that changes the business (anything but a read on a business route, which the API refuses with
 * BUSINESS_SUSPENDED). While the business is suspended the action stays visible, and tapping it explains instead of
 * opening a screen that can only fail. The API's mapped error stays the safety net.
 * - `suspended`: the business's name while suspended, else null.
 * - `allow()`: true when the change can go ahead; otherwise shows the alert and returns false.
 * - `guard(fn)`: `fn`, run only when `allow()` says so (for onPress handlers).
 * The shared Button, TextButton, HeaderButton and ListRow take `write` and do this themselves.
 */
export function useWriteGuard() {
  const suspended = useContext(SuspendedContext);
  return useMemo(() => {
    const allow = () => {
      if (!suspended) return true;
      alertSuspended(suspended);
      return false;
    };
    return {
      suspended,
      allow,
      guard:
        <A extends unknown[]>(fn: (...args: A) => unknown) =>
        (...args: A) => {
          if (allow()) fn(...args);
        },
    };
  }, [suspended]);
}

/** GET /api/memberships carries the status alone. */
export const membershipRestriction = (m: MembershipSummary): RestrictionStatus => m.business.restriction ?? "active";

/** How the switcher names a restriction. Nothing for an active business. */
export const RESTRICTION_LABELS: Record<RestrictionStatus, string | null> = {
  active: null,
  suspended: "Suspended",
  banned: "Closed",
};

const REFUSED: Partial<Record<string, RestrictionStatus>> = {
  BUSINESS_SUSPENDED: "suspended",
  BUSINESS_BANNED: "banned",
};

const overviewKey = () => [useBusinessContext.getState().businessId ?? "default", "overview"];

/** Fetches the overview (which carries `restriction`) and the switcher's list again. */
function refreshRestriction() {
  void queryClient.invalidateQueries({ queryKey: overviewKey() });
  void queryClient.invalidateQueries({ queryKey: ["memberships"] });
}

/**
 * Keeps what's on screen in step with the business's restriction, mounted once in the (app) layout. The overview is
 * fetched again when:
 * - a request is refused with BUSINESS_SUSPENDED or BUSINESS_BANNED and the overview doesn't say so yet (restricted
 *   since it loaded);
 * - a new notification arrives (business.suspended, business.reinstated and business.banned are notifications, and
 *   the badge count is polled while the app is open);
 * - the app returns to the foreground while restricted, so a lifted restriction clears without a pull to refresh.
 */
export function useRestrictionSync(restricted: boolean) {
  useEffect(() => {
    const onError = (error: unknown) => {
      const status = error instanceof ApiError && error.code ? REFUSED[error.code] : undefined;
      if (!status) return;
      const known = restrictionOf(queryClient.getQueryData<Overview>(overviewKey()));
      if (known !== status) refreshRestriction();
    };
    let unread: number | undefined;
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type === "error") onError(event.action.error);
      if (
        event.action.type === "success" &&
        event.query.queryKey[0] === "notifications" &&
        event.query.queryKey[1] === "unread-count"
      ) {
        const total = (event.action.data as { total?: number } | undefined)?.total;
        if (typeof total === "number") {
          if (unread !== undefined && total > unread) void queryClient.invalidateQueries({ queryKey: overviewKey() });
          unread = total;
        }
      }
    });
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.action.error);
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, []);

  useEffect(() => {
    if (!restricted) return;
    const sub = AppState.addEventListener("change", (state) => state === "active" && refreshRestriction());
    return () => sub.remove();
  }, [restricted]);
}
