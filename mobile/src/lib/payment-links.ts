import type { CheckoutStatus, LinkCheckout, PaymentLink, PaymentLinkUnavailableReason, PhoneFieldMode } from "@/lib/api/types";
import { formatNairaShort } from "@/lib/format";

// Payment links: labels and rules shared by the screens. Copy matches web/src/lib/payment-links.ts.

export const LINK_TABS = [
  { key: "all", label: "All" },
  { key: "active", label: "On" },
  { key: "inactive", label: "Off" },
] as const;
export type LinkTab = (typeof LINK_TABS)[number]["key"];

export const CHECKOUT_TABS = [
  { key: "received", label: "Received" },
  { key: "pending", label: "Waiting" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All" },
] as const;
export type CheckoutTab = (typeof CHECKOUT_TABS)[number]["key"];

export const CHECKOUT_STATUS_LABELS: Record<CheckoutStatus, string> = {
  pending: "Waiting",
  expired: "Expired",
  paid: "Paid",
  underpaid: "Part paid",
};

export const UNAVAILABLE_LABELS: Record<PaymentLinkUnavailableReason, string> = {
  inactive: "Turned off",
  expired: "Ended",
  sold_out: "Limit reached",
  account_not_ready: "Account not ready",
};

export const PHONE_LABELS: Record<PhoneFieldMode, string> = { off: "Don't ask", optional: "Optional", required: "Required" };

export const MATCHED_BY_LABELS: Record<NonNullable<LinkCheckout["matchedBy"]>, string> = {
  amount: "Matched on the exact amount",
  reference: "Matched on the reference in the narration",
  manual: "Linked by hand",
};

/** The same limits as backend/src/config/paymentLinks.ts. */
export const LIMITS = { minAmountKobo: 100_00, maxAmountKobo: 100_000_000_00, maxCustomFields: 5, maxAllowedOrigins: 10 } as const;

/** "₦25,000", "Any amount", "From ₦1,000". */
export function priceLabel(link: Pick<PaymentLink, "amountKobo" | "minAmountKobo">) {
  if (link.amountKobo) return formatNairaShort(link.amountKobo);
  return link.minAmountKobo ? `From ${formatNairaShort(link.minAmountKobo)}` : "Any amount";
}

export const linkStateLabel = (link: Pick<PaymentLink, "available" | "unavailableReason">) =>
  link.available ? "On" : UNAVAILABLE_LABELS[link.unavailableReason ?? "inactive"];

/** "3 of 50 paid" for a limited link, otherwise "3 payments". */
export function paymentsLabel(link: Pick<PaymentLink, "paymentsCount" | "maxPayments">) {
  if (link.maxPayments) return `${link.paymentsCount} of ${link.maxPayments} paid`;
  return link.paymentsCount === 1 ? "1 payment" : `${link.paymentsCount} payments`;
}

/** "https://shop.adaeze.ng" -> "shop.adaeze.ng" */
export const originLabel = (origin: string) => origin.replace(/^https:\/\//, "");

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/**
 * A website allowed to embed a link, as an origin. Mirrors normalizeOrigin() in the backend
 * (services/paymentLinks.ts), so the form can say what will be saved; the backend's answer counts.
 */
export function normalizeOrigin(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  const m = /^(https?):\/\/(\*\.)?([^/?#]+)/.exec(s);
  if (!m) return null;
  const [, scheme, wild, hostPort] = m;
  if (hostPort!.includes("@") || hostPort!.includes("*")) return null;
  const host = hostPort!.split(":")[0]!;
  const port = hostPort!.includes(":") ? hostPort!.slice(hostPort!.indexOf(":")) : "";
  if (port && !/^:\d{1,5}$/.test(port)) return null;
  const local = isLocalHost(host);
  if (scheme !== "https" && !(scheme === "http" && local)) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (wild && (host.split(".").length < 2 || /^(com|org|gov|edu|net)\.[a-z]{2}$/.test(host))) return null;
  return `${scheme}://${wild ?? ""}${host}${port}`;
}

/** An end date picked as a day ends at the end of that day in Lagos. */
export const endOfLagosDay = (day: string) => new Date(`${day}T23:59:59+01:00`).toISOString();
