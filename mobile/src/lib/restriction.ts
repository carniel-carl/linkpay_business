// Compliance restrictions on a business (docs/briefs/compliance.md §6). The business is told that it's restricted,
// never why. Suspended: every read works and every change is refused (BUSINESS_SUSPENDED), so Home shows a banner and
// drops the actions that can only fail. Banned, shown as "Closed": every business route is refused (BUSINESS_BANNED),
// so the closed screen covers the tabs.
import { useEffect } from "react";
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
