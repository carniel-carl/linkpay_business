// Payment links (contract: docs/briefs/payment-links.md).
//
// Liquifia collects only by bank transfer into a branch's one fixed account, with no payer reference we can
// rely on. So each checkout asks for a unique amount (the price plus 1 to 99 kobo) and shows a reference
// ("LP-7K2Q9M") to put in the narration. Either one ties the transfer to the checkout.

export const PAYMENT_LINK_LIMITS = {
  /** ₦100 to ₦100m per payment. */
  minAmountKobo: 100_00,
  maxAmountKobo: 100_000_000_00,
  /** Extra questions a link can ask the payer, besides name, email and phone. */
  maxCustomFields: 5,
  /** Links per business, active or not. */
  maxLinks: 500,
  /** Pictures on a link (the first is the cover). */
  maxImages: 4,
} as const;

/** Pictures on payment links: re-encoded by us, never served as uploaded. */
export const LINK_IMAGE_RULES = {
  /** Longest side after resizing. */
  maxSide: 1600,
  /** Smaller than this on both sides is refused. */
  minSide: 64,
  webpQuality: 82,
  /** Uploads never attached to a link are deleted after this long. */
  unattachedHours: 24,
} as const;

export const CHECKOUT_RULES = {
  /** How long the payer is shown to have to send the money. */
  payWithinMinutes: 30,
  /** The unique amount stays reserved (and is matched) this long after the checkout starts, for slow banks. */
  amountHoldMinutes: 120,
  /** A transfer is matched on amount only if it arrived no earlier than this before the checkout (bank clocks). */
  clockSlackMinutes: 5,
  /** A transfer naming the checkout's reference is matched for this long, at any amount. */
  referenceMatchDays: 7,
  /** Kobo added to the price to make the amount unique: 1..99. */
  maxOffsetKobo: 99,
  /**
   * The most of one account's amounts for a price (its 99) that one address (an IPv4 address or an IPv6 /48)
   * or one payer email can hold at a time with unpaid live checkouts, so nobody can take the whole pool.
   * Paying a checkout frees its amount. On a link with a payment limit the same caps also count across the
   * whole link (every price), and are lowered to `maxPlacesShare` of the limit.
   */
  maxOpenPerIp: 10,
  maxOpenPerEmail: 3,
  /** The most of a link's `maxPayments` places one address or email can hold at once (at least 1). */
  maxPlacesShare: 0.1,
  /**
   * How IPv6 addresses are grouped into one "address" for the caps above. One home, office or small hosting
   * customer usually gets a whole /48, so a /56 (256 per /48) would let one of them act as hundreds of payers.
   */
  ipv6Subnet: 48,
} as const;

// Embedding a link on the business's own website (contract: docs/briefs/payment-links.md §5).
export const EMBED_LIMITS = {
  /** Websites a link can be limited to (none = any site). */
  maxAllowedOrigins: 10,
  /** The business's own order id or reference, passed by its website and returned with the checkout. */
  maxClientReferenceLength: 100,
  /** Extra key/value pairs the website can attach to a checkout. */
  maxMetadataKeys: 10,
  maxMetadataValueLength: 500,
} as const;

// Donation links (fundraisers, like GoFundMe; contract: docs/briefs/donations.md). A donation link is a payment
// link where the donor chooses the amount, with an optional goal, a public list of donors and a report button.
export const DONATION_LIMITS = {
  /** A goal of ₦1,000 to ₦10bn. */
  minGoalKobo: 1_000_00,
  maxGoalKobo: 10_000_000_000_00,
  /** Quick-pick amounts on the page ("₦5,000", "₦10,000", ...). */
  maxSuggestedAmounts: 4,
  /** The donor's words of support, shown on the page. */
  maxMessageLength: 280,
  /** Donors per page of the public list. */
  maxDonorsPage: 50,
} as const;

/** Why someone reports a link to LinkPay. The labels are what the report form shows. */
export const LINK_REPORT_REASONS = {
  fraud: "It's a scam or the money won't go where it says",
  misleading: "The story or the goal is misleading",
  impersonation: "It pretends to be someone else",
  prohibited: "It's raising money for something illegal",
  offensive: "Offensive words or pictures, or an offensive donation message",
  other: "Something else",
} as const;
export type LinkReportReason = keyof typeof LINK_REPORT_REASONS;
export const LINK_REPORT_REASON_KEYS = Object.keys(LINK_REPORT_REASONS) as [LinkReportReason, ...LinkReportReason[]];

export const LINK_REPORT_LIMITS = {
  maxDetailsLength: 2000,
  /** Reports per IP address, so the queue can't be flooded. */
  perIpPerHour: 5,
} as const;
