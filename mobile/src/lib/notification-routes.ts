import { router, type Href } from "expo-router";
import { useBusinessContext } from "@/lib/business-context";

/** What a notification (from the list, or a tapped push's `data`) needs to open its screen. */
export type NotificationTarget = { type: string; businessId?: string | null; data: Record<string, unknown> };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * The mobile screen for a notification. Routed from `type` and its ids, never from `link` (a web path).
 * Mirrors docs/briefs/notifications.md §4; anything unknown opens the notifications list.
 */
export function hrefFor({ type, data }: NotificationTarget): Href {
  const family = type.split(".")[0];
  if (family === "transfer") {
    const ids = Array.isArray(data.transferIds) ? data.transferIds.filter((x): x is string => typeof x === "string") : [];
    // One transfer opens it; a bulk batch opens the Transfers view (bulk is web-only on mobile).
    return ids.length === 1 ? { pathname: "/payments/transfer/[id]", params: { id: ids[0] } } : { pathname: "/payments", params: { view: "transfers" } };
  }
  if (type === "payment.received") {
    const id = str(data.transactionId);
    return id ? { pathname: "/payments/[id]", params: { id } } : "/payments";
  }
  if (type === "payment_link.paid") {
    const id = str(data.checkoutId);
    return id ? { pathname: "/payment-links/checkout/[id]", params: { id } } : "/payment-links";
  }
  // LinkPay staff paused a link, or turned it back on.
  if (type === "payment_link.taken_down" || type === "payment_link.restored") {
    const id = str(data.paymentLinkId);
    return id ? { pathname: "/payment-links/[id]", params: { id } } : "/payment-links";
  }
  if (family === "invoice") {
    const id = str(data.invoiceId);
    return id ? { pathname: "/invoices/[id]", params: { id } } : "/invoices";
  }
  if (type === "savings.safelock_released") {
    const id = str(data.safelockId);
    return id ? { pathname: "/savings/safelock/[id]", params: { id } } : { pathname: "/savings", params: { view: "safelock" } };
  }
  if (family === "savings") {
    const id = str(data.pocketId);
    return id ? { pathname: "/savings/[id]", params: { id } } : "/savings";
  }
  if (type === "kyb.changes_requested" || type === "kyb.rejected") return "/onboarding";
  if (type === "team.member_joined") return "/team";
  if (type === "security.new_sign_in") return "/more/devices";
  if (type === "kyb.approved" || type === "account.ready" || type === "team.role_changed" || type === "team.removed") return "/";
  return "/notifications";
}

/**
 * Opens a notification's screen. A notification about another business switches to it first, so the screen
 * shows that business's data; "removed from a team" never switches to the business it's about.
 */
export function openNotification(target: NotificationTarget) {
  const { businessId: current, setBusinessId } = useBusinessContext.getState();
  const businessId = target.businessId ?? str(target.data.businessId);
  if (target.type === "team.removed") {
    if (businessId && current === businessId) setBusinessId(undefined);
  } else if (businessId && businessId !== current) {
    setBusinessId(businessId);
  }
  const href = hrefFor(target);
  // A detail screen is pushed onto its tab's stack; a tab's own screen is switched to.
  if (typeof href === "object" && href.pathname.includes("[id]")) router.push(href);
  else router.navigate(href);
}
