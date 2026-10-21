// Shapes returned by the backend (see docs/IMPLEMENTATION.md, section 4). Mirrors web/src/lib/api/types.ts.
import type { BusinessType, DocumentType, IdType, PersonRole } from "@/lib/kyb";

export type TwoFactorMethod = "totp" | "email";

export type User = {
  _id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: "user" | "admin";
  twoFactor?: { enabled: boolean; method: TwoFactorMethod | null };
  createdAt: string;
  updatedAt: string;
};

/** A sign-in made with `device`: a short access token plus a rotating refresh token. */
export type DeviceSession = { accessToken: string; refreshToken: string; sessionId: string; user: User };

export type TwoFactorChallenge = { twoFactorRequired: true; method: TwoFactorMethod; challengeToken: string };

export type SignInResponse = DeviceSession | TwoFactorChallenge;

export type RefreshResponse = { accessToken: string; refreshToken: string; sessionId: string };

export type SignedInDevice = {
  _id: string;
  device: { name: string; platform: "ios" | "android" | "web" | "other"; model?: string; osVersion?: string; appVersion?: string };
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
  /** This phone can sign back in with Face ID / fingerprint. */
  biometricSignIn?: boolean;
};

// ---- Business, branches and accounts ----

export type BusinessStatus = "draft" | "submitted" | "changes_requested" | "approved" | "rejected";

/** Bank account setup with the banking partner, per branch. */
export type AccountSetupStatus = "not_started" | "pending" | "active" | "failed";

export type BranchRef = { _id: string; name: string; isHeadOffice: boolean };

export type Address = { street?: string; city?: string; state?: string; country?: string };

/** GET /api/branches and the overview. `account` is null until the branch's account is open. */
export type Branch = BranchRef & {
  address?: Address;
  manager?: { name?: string; email?: string; phone?: string };
  liquifia: { accountStatus: AccountSetupStatus };
  account: { id: string; accountNumber: string; accountName?: string; bankName?: string; currency: "NGN" } | null;
};

export type Business = {
  _id: string;
  name: string;
  type: BusinessType;
  registrationNumber?: string;
  tin?: string;
  industry?: string;
  description?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: Address;
  /** Empty for members below admin. */
  people: Person[];
  status: BusinessStatus;
  reviewNote?: string;
  submittedAt?: string;
  reviewedAt?: string;
  liquifia?: { accountStatus: AccountSetupStatus };
};

// ---- Verification (KYB) ----

/** A principal on the business. The BVN itself is never returned, only its last 4 digits. */
export type Person = {
  _id: string;
  fullName: string;
  roles: PersonRole[];
  email?: string;
  phone?: string;
  ownershipPercent?: number;
  idType?: IdType;
  bvnLast4?: string;
};

export type KybDocument = {
  _id: string;
  type: DocumentType;
  /** Set on government_id uploads: whose ID it is. */
  person?: string;
  originalName: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg";
  size: number;
  status: "uploaded" | "accepted" | "rejected";
  rejectionReason?: string;
  createdAt: string;
};

/** Keys: `field:<name>`, `document:<type>`, `people:principal`, `person:<id>:bvn|idType|government_id`. */
export type ChecklistItem = { key: string; label: string; done: boolean; rejectionReason?: string };

export type Permission =
  | "accounts.view"
  | "branches.manage"
  | "team.manage"
  | "transfers.create"
  | "transfers.approve"
  | "transfers.manage"
  | "invoices.manage"
  | "savings.manage"
  | "payments.manage";

/** `branches: null` means every branch. Decide from `permissions`, never from the role name. */
export type Membership = { _id: string; role: string; permissions: Permission[]; branches: string[] | null };

/** GET /api/business: the member's view of the business. Branches are head office first. */
export type Overview = {
  business: Business;
  /** Empty for members below admin. */
  documents: KybDocument[];
  branches: Branch[];
  /** What verification still needs, for the business's type. Empty items for members below admin. */
  checklist: { complete: boolean; items: ChecklistItem[] };
  membership?: Membership;
};

/** GET /api/memberships, for the business switcher. */
export type MembershipSummary = {
  business: { _id: string; name: string; status: BusinessStatus };
  role: string;
  roleLabel?: string;
  isOwner: boolean;
};

/** GET /api/accounts. Money is integer kobo; `balance: null` means it's unavailable right now. */
export type Account = {
  _id: string;
  branch: BranchRef;
  label: string;
  accountNumber: string;
  accountName?: string;
  bankName?: string;
  currency: "NGN";
  /**
   * `availableKobo` is what can be sent: the bank balance minus money held for pending transfers and money set
   * aside in savings (`savedKobo`, pockets and Safelocks; `lockedKobo` is the Safelock part). Use it when present.
   */
  balance: {
    amountKobo: number;
    currency: "NGN";
    heldKobo?: number;
    savedKobo?: number;
    lockedKobo?: number;
    availableKobo?: number;
  } | null;
};

// ---- Transactions ----

export type TransactionStatus = "pending" | "success" | "failed" | "reversed";

export type Transaction = {
  _id: string;
  type: "inbound_transfer" | (string & {});
  direction: "credit" | "debit";
  amountKobo: number;
  feeKobo: number;
  netKobo: number;
  currency: "NGN";
  status: TransactionStatus;
  counterparty: { name?: string; bankName?: string; accountNumber?: string };
  narration: string | null;
  reference: string | null;
  occurredAt: string;
  branch: BranchRef | null;
  account: { _id: string; label: string; accountNumber: string; bankName?: string } | null;
  /** Payouts: the transfer they belong to. */
  transfer?: string | null;
};

export type TransactionList = { items: Transaction[]; total: number; skip: number; take: number };

/** Successful transactions only. */
export type TransactionSummary = { inflowKobo: number; outflowKobo: number; feesKobo: number; count: number; currency: "NGN" };

// ---- Team ----

/** GET /api/team/members. `branches: []` means every branch. */
export type TeamMember = {
  _id: string;
  user: { _id: string; name: string; email: string } | null;
  role: string;
  branches: BranchRef[];
  isYou: boolean;
  joinedAt: string;
};

/** GET /api/team/invites (pending only). `branches: []` means every branch. */
export type Invite = {
  _id: string;
  email: string;
  role: string;
  branches: BranchRef[];
  status: "pending" | "accepted" | "revoked";
  /** Still pending, but past `expiresAt`. */
  expired: boolean;
  expiresAt: string;
  lastSentAt: string;
  invitedBy: { _id: string; name: string } | null;
  createdAt: string;
};

export type RoleInfo = {
  role: string;
  label: string;
  permissions: Permission[];
  /** Can be given through an invite or a role change (everything except owner). */
  assignable: boolean;
  /** Always covers every branch (owner, admin). */
  businessWide: boolean;
};

export type RolesResponse = { roles: RoleInfo[]; permissions: { key: Permission; label: string }[] };

/** GET /api/invites/:token (public). */
export type InvitePreview = {
  email: string;
  role: string;
  roleLabel: string;
  business: { _id?: string; name?: string };
  /** `[]` means every branch. */
  branches?: BranchRef[];
  invitedBy: string | null;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  accountExists: boolean;
};

export type InviteAccepted = { business: { _id: string; name: string; status: BusinessStatus }; membership: Membership };

// ---- Transfers ----

export type TransferKind = "bank" | "internal" | "linkpay";

export type TransferStatus = "pending_approval" | "rejected" | "cancelled" | "processing" | "success" | "failed";

/** GET /api/transfers items. Money is integer kobo; the account is debited `totalKobo` (amount + fee). */
export type Transfer = {
  _id: string;
  kind: TransferKind;
  status: TransferStatus;
  amountKobo: number;
  feeKobo: number;
  stampDutyKobo: number;
  totalKobo: number;
  currency: "NGN";
  branch: BranchRef | null;
  batch: string | null;
  recipient: { accountNumber: string; accountName: string; bankName: string | null; branch: BranchRef | null };
  narration: string | null;
  reference: string;
  failureReason: string | null;
  createdBy: { _id: string; name: string } | null;
  /** The final approval, or the rejection. Stays null while the transfer moves between levels. */
  decision: { by: { _id: string; name: string } | null; at: string; note: string | null } | null;
  /** Null when the transfer didn't need approval. */
  approval: TransferApproval | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  /** The member is an approver at the current level, didn't approve an earlier one, and didn't create it. */
  canApprove: boolean;
  /** Waiting for approval and the member created it. */
  canCancel: boolean;
};

export type ApprovalLevelStatus = "approved" | "waiting" | "upcoming" | "rejected" | "cancelled" | "not_reached";

/** One level of a transfer's approval. `any`: anyone who can approve clears it (`approvers` is then empty). */
export type ApprovalLevel = {
  level: number;
  any: boolean;
  approvers: { _id: string; name: string }[];
  status: ApprovalLevelStatus;
  approvedBy: { _id: string; name: string } | null;
  approvedAt: string | null;
  note: string | null;
};

/** `current` is the 1-based level waiting for a decision, null when nothing is waiting. */
export type TransferApproval = { current: number | null; levels: ApprovalLevel[] };

export type TransferList = { items: Transfer[]; total: number; skip: number; take: number };

export type Bank = { uuid: string; name: string; code: string | null };

/** POST /api/transfers/resolve-account: the bank's name enquiry. `label` names the receiving LinkPay business or branch. */
export type ResolvedAccount = { accountNumber: string; accountName: string; bankName: string | null; kind: TransferKind; label: string | null };

/** GET /api/transfers/fee */
export type FeeQuote = {
  amountKobo: number;
  feeKobo: number;
  stampDutyKobo: number;
  totalKobo: number;
  needsApproval: boolean;
  /** How many approvals the signed-in member's transfer would need (0 = goes straight away). */
  approvalLevels: number;
};

export type ApprovalRuleMode = "never" | "always" | "above_threshold" | "workflow";

/** A workflow tier: transfers from `minKobo` go through its levels in order. Edited on the web only. */
export type ApprovalTier = {
  minKobo: number;
  levels: { approvers: { _id: string; name: string; role: string | null; roleLabel: string | null; canApprove: boolean }[] }[];
};

export type ApprovalRule = { mode: ApprovalRuleMode; thresholdKobo: number | null; tiers: ApprovalTier[] };

// ---- Invoices (/api/invoices; shapes from backend/src/controllers/invoices.ts) ----

/** Stored statuses. "Overdue" isn't one: it's an unpaid invoice past its due date (`overdue`). */
export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "void";
export type PaymentMethod = "transfer" | "cash" | "pos" | "cheque" | "other";

export type InvoiceItem = { description: string; quantity: number; unitPriceKobo: number; amountKobo: number };

/** As the API returns and accepts it. */
export type InvoiceDiscount = { type: "amount"; amountKobo: number } | { type: "percent"; percentBps: number };

export type InvoiceCustomerDetails = {
  /** The saved customer this came from, if any. */
  ref: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
};

export type InvoicePayment = {
  _id: string;
  amountKobo: number;
  method: PaymentMethod;
  /** The incoming payment this is, when it's one of ours. */
  transaction: string | null;
  /** Matched by itself from the transfer's narration. */
  auto: boolean;
  note: string | null;
  paidAt: string;
  recordedBy: { _id: string; name: string } | null;
};

/** The account the customer pays into: the invoice branch's. */
export type PayTo = { accountNumber: string; accountName: string | null; bankName: string | null };

/** GET /api/invoices items. Dates are Lagos calendar days, "YYYY-MM-DD". */
export type InvoiceListItem = {
  _id: string;
  number: string;
  status: InvoiceStatus;
  displayStatus: InvoiceStatus | "overdue";
  overdue: boolean;
  daysOverdue: number;
  branch: BranchRef | null;
  customer: InvoiceCustomerDetails;
  issueDate: string;
  dueDate: string;
  currency: "NGN";
  totalKobo: number;
  paidKobo: number;
  balanceKobo: number;
  issuedAt: string | null;
  lastSentAt: string | null;
  viewedAt: string | null;
  paidAt: string | null;
  createdAt: string;
};

/** GET /api/invoices/:id */
export type Invoice = InvoiceListItem & {
  items: InvoiceItem[];
  subtotalKobo: number;
  discount: InvoiceDiscount | null;
  discountKobo: number;
  /** Basis points (750 = 7.5%), null when there's no VAT. */
  vatRateBps: number | null;
  vatKobo: number;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  payments: InvoicePayment[];
  lastSentTo: string | null;
  voidedAt: string | null;
  receiptSentAt: string | null;
  reminders: { enabled: boolean; sent: string[]; lastSentAt: string | null };
  /** The customer's page; null while it's a draft. */
  publicUrl: string | null;
  payTo: PayTo | null;
  createdBy: { _id: string; name: string } | null;
};

export type InvoiceList = { items: InvoiceListItem[]; total: number; skip: number; take: number };

/** GET /api/invoices/summary */
export type InvoiceSummary = {
  outstandingKobo: number;
  overdueKobo: number;
  unpaidCount: number;
  overdueCount: number;
  collectedThisMonthKobo: number;
  counts: Record<InvoiceStatus, number>;
  currency: "NGN";
};

/** GET /api/invoices/defaults: what a new invoice starts with. */
export type InvoiceDefaults = {
  issueDate: string;
  dueDate: string;
  /** Null unless VAT is on by default. */
  vatRateBps: number | null;
  defaultVatRateBps: number;
  notes: string | null;
  terms: string | null;
  footer: string | null;
  nextNumber: string;
};

/** GET /api/invoices/:id/suggested-payments items: incoming payments that look like they're for it. */
export type SuggestedPayment = {
  _id: string;
  amountKobo: number;
  counterparty: { name: string | null; bankName: string | null };
  narration: string | null;
  reference: string | null;
  occurredAt: string;
  /** The amount is exactly what's still owed. */
  exactAmount: boolean;
};

/** The business's saved customers (GET /api/invoices/customers). */
export type InvoiceCustomer = { _id: string; name: string; email?: string | null; phone?: string | null; address?: string | null };
export type InvoiceCustomerList = { items: InvoiceCustomer[]; total: number; skip: number; take: number };

/** Colours for the business's documents, worked out by the backend from its accent colour. */
export type BrandPalette = {
  /** Bands and fills. */
  accent: string;
  /** Text on `accent`. */
  onAccent: string;
  /** Accent-coloured text on white, darkened until it's readable. */
  accentText: string;
};

/** GET /api/branding */
export type Branding = {
  /** `url` is an API path ("/api/branding/logo?v=…") that needs the session. */
  logo: { url: string; width: number; height: number } | null;
  accentColor: string | null;
  palette: BrandPalette;
  invoice: {
    prefix: string;
    defaultDueDays: number;
    vatRateBps: number;
    vatByDefault: boolean;
    notes: string | null;
    terms: string | null;
    footer: string | null;
  };
};

// ---- Notifications (/api/notifications; contract in docs/briefs/notifications.md) ----

/** One notification. `link` is a web path; the app routes from `type` and `data`. */
export type AppNotification = {
  _id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  /** Null for account-level ones (security). */
  business: { _id: string; name: string | null } | null;
  /** Ids for opening the right screen: transferIds, batchId, invoiceId, transactionId, branchId, businessId, userId. */
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = { items: AppNotification[]; nextBefore: string | null };
export type UnreadCount = { total: number; byBusiness: Record<string, number> };

// ---- Savings (docs/briefs/savings.md) ----

export type PocketColor = "lime" | "green" | "teal" | "blue" | "violet" | "pink" | "orange" | "amber" | "slate";

/** Icon keys the API accepts. `POCKET_ICONS` in lib/savings maps each to SF Symbols and Material Symbols. */
export type PocketIcon =
  | "savings" | "tax" | "payroll" | "rent" | "shop" | "stock" | "delivery" | "power" | "repairs" | "equipment"
  | "vehicle" | "travel" | "marketing" | "growth" | "emergency" | "loan" | "training" | "health" | "events" | "goal";

export type PocketAutoSave =
  | { percentBps: number; amountKobo: null; since: string }
  | { percentBps: null; amountKobo: number; since: string };

/** A named pot inside one branch's account. The money never leaves the account; it's taken out of `availableKobo`. */
export type Pocket = {
  _id: string;
  name: string;
  /** null shows the savings icon. */
  icon: PocketIcon | null;
  color: PocketColor;
  status: "active" | "closed";
  branch: BranchRef | null;
  balanceKobo: number;
  currency: "NGN";
  target: {
    amountKobo: number;
    /** YYYY-MM-DD */
    date: string | null;
    reachedAt: string | null;
    /** 0..10000, capped. */
    progressBps: number;
    remainingKobo: number;
  } | null;
  autoSave: PocketAutoSave | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  closedAt: string | null;
  /** The member has savings.manage and the pocket is open. */
  canManage: boolean;
};

export type PocketList = { items: Pocket[]; savedKobo: number; currency: "NGN" };

// ---- Safelock (/api/safelocks; docs/briefs/savings.md §6) ----

/**
 * A fixed amount of one branch's available balance, held until `unlockOn` (midnight, Lagos). It can't be
 * broken early, topped up, shortened or extended; only the title changes.
 */
export type Safelock = {
  _id: string;
  title: string;
  status: "locked" | "released";
  branch: BranchRef | null;
  amountKobo: number;
  currency: "NGN";
  /** YYYY-MM-DD, Lagos. */
  lockedOn: string;
  unlockOn: string;
  /** The moment it unlocks, for a countdown. */
  unlockAt: string;
  totalDays: number;
  /** 0 once released. */
  daysLeft: number;
  /** 0..10000: how far through the lock period. */
  progressBps: number;
  releasedAt: string | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  /** savings.manage, and still locked. */
  canRename: boolean;
};

/** `lockedKobo` sums the running locks in the list. */
export type SafelockList = { items: Safelock[]; lockedKobo: number; currency: "NGN" };

/** GET /api/safelocks/limits. Never hard-code these. */
export type SafelockLimits = {
  minAmountKobo: number;
  maxAmountKobo: number;
  minDays: number;
  maxDays: number;
  earliestUnlockOn: string;
  latestUnlockOn: string;
  maxPerBranch: number;
  canBreakEarly: false;
  interestRateBps: number;
};

export type PocketMovement = {
  _id: string;
  kind: "deposit" | "withdrawal" | "auto_save" | "close";
  direction: "in" | "out";
  amountKobo: number;
  balanceAfterKobo: number;
  note: string | null;
  /** auto_save: the incoming payment. */
  transaction: string | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
};

export type PocketActivity = { items: PocketMovement[]; nextBefore: string | null };

// ---- Payment links (contract: docs/briefs/payment-links.md) ----

export type PhoneFieldMode = "off" | "optional" | "required";
export type PaymentLinkUnavailableReason = "taken_down" | "inactive" | "expired" | "sold_out" | "account_not_ready";
/** "donation": a fundraiser (donor chooses, optional goal, public donor list). Contract: docs/briefs/donations.md. */
export type PaymentLinkKind = "payment" | "donation";

/** A fundraiser's figures. Raised includes the few kobo that tell transfers apart; test payments never count. */
export type DonationProgress = {
  goalKobo: number | null;
  raisedKobo: number;
  donationsCount: number;
  /** Floor of raised / goal, can pass 100; null without a goal. */
  percent: number | null;
  lastDonationAt: string | null;
};
export type CheckoutStatus = "pending" | "expired" | "paid" | "underpaid";
/** "test": placeholder bank details and simulated payments, never counted in totals (brief §6). */
export type PaymentMode = "live" | "test";

/** A picture on a payment link. `url` is an API path (signed in on the dashboard routes). */
export type PaymentLinkImage = { _id: string; url: string; width: number; height: number };

export type PaymentLink = {
  _id: string;
  title: string;
  description: string | null;
  slug: string;
  /** WEB_URL/pay/<slug> */
  url: string;
  branch: BranchRef | null;
  kind: PaymentLinkKind;
  /** null = the payer chooses (at least `minAmountKobo`, if set). Always null on donation links. */
  amountKobo: number | null;
  minAmountKobo: number | null;
  /** Donation links only: progress (raised = collectedKobo) and the quick picks. */
  donation: (DonationProgress & { suggestedAmountsKobo: number[] }) | null;
  /** LinkPay staff paused the link; only they can turn it back on. */
  takenDown: { at: string } | null;
  phone: PhoneFieldMode;
  customFields: { _id: string; label: string; required: boolean }[];
  /** In order; the first is the cover. */
  images: PaymentLinkImage[];
  successMessage: string | null;
  redirectUrl: string | null;
  status: "active" | "inactive";
  mode: PaymentMode;
  /** Websites that may embed it; [] = any site. */
  allowedOrigins: string[];
  expiresAt: string | null;
  maxPayments: number | null;
  /** Live payments only. */
  paymentsCount: number;
  collectedKobo: number;
  lastPaidAt: string | null;
  available: boolean;
  unavailableReason: PaymentLinkUnavailableReason | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  canManage: boolean;
};

export type PaymentLinkList = { items: PaymentLink[]; total: number; skip: number; take: number };

export type PaymentLinkSummary = {
  links: { active: number; inactive: number };
  collectedKobo: number;
  paymentsCount: number;
  last30Days: { collectedKobo: number; paymentsCount: number };
};

/** GET /api/payment-links/:id/embed */
export type PaymentLinkEmbed = {
  url: string;
  scriptUrl: string;
  button: string;
  inline: string;
  javascript: string;
  allowedOrigins: string[];
  verifyUrl: string;
  mode: PaymentMode;
};

/** One payer's checkout, as the team sees it. */
export type LinkCheckout = {
  _id: string;
  reference: string;
  status: CheckoutStatus;
  /** The link's mode when the checkout started. */
  mode: PaymentMode;
  link: { _id: string; title: string; slug: string } | null;
  branch: BranchRef | null;
  payer: { name: string; email: string; phone: string | null; fields: { label: string; value: string }[] };
  /** Donation links: whether the name is hidden on the public page, and their words of support. */
  donor: { anonymous: boolean; message: string | null } | null;
  /** LinkPay staff took this donation off the public list (it still counts). */
  hiddenFromPage: boolean;
  priceKobo: number;
  /** What the payer was asked to send: the price plus 1 to 99 kobo. */
  amountKobo: number;
  paidKobo: number | null;
  paidAt: string | null;
  source: "page" | "embed";
  embedOrigin: string | null;
  clientReference: string | null;
  metadata: Record<string, string>;
  matchedBy: "amount" | "reference" | "manual" | "simulated" | null;
  matchedByUser: { _id: string; name: string } | null;
  expiresAt: string;
  createdAt: string;
  /** Never on test checkouts. */
  canMatch: boolean;
  /** A pending test checkout, for members who manage links. */
  canSimulate: boolean;
};

export type LinkCheckoutList = { items: LinkCheckout[]; total: number; skip: number; take: number };
