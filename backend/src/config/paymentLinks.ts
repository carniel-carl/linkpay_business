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
