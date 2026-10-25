// Response shapes from the backend (`backend/src/models`, `backend/src/controllers`).
import type {
  BusinessStatus,
  BusinessType,
  DocumentType,
  IdType,
  PersonRole,
} from "@/lib/kyb"

export type TwoFactorMethod = "totp" | "email"

export type User = {
  _id: string
  name: string
  email: string
  emailVerified: boolean
  /** False when verifying the email removed a password chosen before it was proven. A reset sets one. */
  hasPassword?: boolean
  twoFactor?: {
    enabled: boolean
    method: TwoFactorMethod | null
    /** Unused recovery codes. 0 unless the method is the authenticator app. */
    recoveryCodesLeft: number
  }
  createdAt: string
  updatedAt: string
}

/** GET /api/transaction-pin, and the body every PIN endpoint returns. One PIN per user, for every business. */
export type TransactionPinStatus = {
  isSet: boolean
  locked: boolean
  /** ISO time the lock ends, while it's locked. */
  lockedUntil: string | null
  /** Tries left before it locks (5 after a right PIN); null when no PIN is set. */
  attemptsLeft: number | null
  changedAt: string | null
}

export type Person = {
  _id: string
  fullName: string
  roles: PersonRole[]
  email?: string
  phone?: string
  ownershipPercent?: number
  idType?: IdType
  // The BVN itself is never returned, only its last 4 digits.
  bvnLast4?: string
}

export type Address = {
  street?: string
  city?: string
  state?: string
  country?: string
}

export type Owner = { _id: string; name: string; email: string }

/** Bank account setup with the banking partner (Liquifia/Pouch). Owners only get `accountStatus`. */
export type AccountSetupStatus = "not_started" | "pending" | "active" | "failed"
export type LiquifiaInfo = { accountStatus: AccountSetupStatus; customerId?: string; lastError?: string }

/** A business bank account (NGN virtual account), one per branch. Money is always integer kobo. */
export type Account = {
  _id: string
  /** Populated on GET /api/accounts; an id elsewhere. */
  branch?: BranchRef | string
  label: string
  accountNumber: string
  accountName?: string
  bankName?: string
  currency: "NGN"
  status: string
  createdAt: string
}

/**
 * `amountKobo` is the bank balance. `heldKobo` is held by transfers waiting for approval (or for the bank),
 * `savedKobo` is set aside in savings (pockets and Safelocks; `lockedKobo` is the Safelock part), and
 * `availableKobo` is what can be sent (bank balance minus held and saved). These are absent from older backends.
 */
export type Balance = {
  amountKobo: number
  currency: "NGN"
  heldKobo?: number
  savedKobo?: number
  lockedKobo?: number
  availableKobo?: number
}

/** GET /api/accounts. `balance: null` means the balance is temporarily unavailable. */
export type AccountWithBalance = Account & { balance: Balance | null }

export type BranchRef = { _id: string; name: string; isHeadOffice: boolean }

/** A branch's own account details (no balance; balances come from GET /api/accounts). */
export type BranchAccount = {
  id: string
  accountNumber: string
  accountName?: string
  bankName?: string
  currency: "NGN"
}

/** GET /api/branches. The head office is created on approval; each branch gets its own account. */
export type Branch = BranchRef & {
  business: string
  address?: Address
  manager?: { name?: string; email?: string; phone?: string }
  /** Owners only get `accountStatus`; admins also get `lastError`. */
  liquifia: { accountStatus: AccountSetupStatus; lastError?: string }
  account: BranchAccount | null
  createdAt: string
  updatedAt: string
}

export type Business = {
  _id: string
  // Populated with name and email on admin endpoints.
  owner: string | Owner
  name: string
  type: BusinessType
  registrationNumber?: string
  tin?: string
  industry?: string
  description?: string
  email?: string
  phone?: string
  website?: string
  address?: Address
  people: Person[]
  status: BusinessStatus
  reviewNote?: string
  submittedAt?: string
  reviewedAt?: string
  liquifia?: LiquifiaInfo
  /** GET /api/business only: whether compliance has restricted the business (never why). Absent on admin endpoints. */
  restriction?: Restriction
  createdAt: string
  updatedAt: string
}

/**
 * A compliance restriction (docs/briefs/compliance.md). Suspended: every read works and every change is refused
 * (BUSINESS_SUSPENDED). Banned, shown as "Closed": every business route is refused (BUSINESS_BANNED), except
 * GET /api/business and GET /api/memberships, which say so.
 */
export type RestrictionStatus = "active" | "suspended" | "banned"
/** `since` is null while active. */
export type Restriction = { status: RestrictionStatus; since: string | null }

export type DocumentStatus = "pending" | "accepted" | "rejected"

export type KybDocument = {
  _id: string
  business: string
  type: DocumentType
  person?: string
  originalName: string
  mimeType: "application/pdf" | "image/png" | "image/jpeg"
  size: number
  status: DocumentStatus
  rejectionReason?: string
  createdAt: string
  updatedAt: string
}

export type ChecklistItem = {
  key: string
  label: string
  done: boolean
  rejectionReason?: string
}

export type Checklist = { complete: boolean; items: ChecklistItem[] }

/** Every /api/business and /api/admin/businesses/:id endpoint returns this. */
export type Overview = {
  business: Business
  documents: KybDocument[]
  /** Account details without balances. Empty until the account is set up. */
  accounts: Account[]
  /** Head office first. Empty until the business is approved. */
  branches: Branch[]
  checklist: Checklist
  /**
   * The signed-in user's place in this business (GET /api/business only). Decide what to show
   * from `permissions`, never from the role name. Absent on admin endpoints.
   */
  membership?: Membership
}

export type AuthSession = { accessToken: string; user: User }

/** POST /api/auth/login/2fa. A sign-in with a recovery code also says how many are left. */
export type TwoFactorSession = AuthSession & { recoveryCodeUsed?: true; recoveryCodesLeft?: number }

/** Shown once: when the authenticator app is turned on, and from POST /api/auth/2fa/recovery-codes. */
export type RecoveryCodes = { recoveryCodes: string[] }

export type TwoFactorChallenge = {
  twoFactorRequired: true
  method: TwoFactorMethod
  challengeToken: string
}

// ---- Team ----

/** Checked by the backend on every route; the web hides what a member can't use. */
export type Permission =
  | "accounts.view"
  | "branches.manage"
  | "team.manage"
  | "transfers.create"
  | "transfers.approve"
  | "transfers.manage"
  | "invoices.manage"
  | "savings.manage"
  | "payments.manage"

/** Fixed roles today; custom roles may come later, so treat unknown names gracefully. */
export type TeamRole = "owner" | "admin" | "finance" | "approver" | "viewer" | (string & {})

/** `branches: null` means every branch. */
export type Membership = { _id: string; role: TeamRole; permissions: Permission[]; branches: string[] | null }

/** GET /api/memberships: every business the user belongs to, for the business switcher. */
export type MembershipSummary = {
  /** `restriction` is the status alone here, not GET /api/business's `{ status, since }`. */
  business: { _id: string; name: string; status: BusinessStatus; restriction?: RestrictionStatus }
  role: TeamRole
  roleLabel?: string
  isOwner: boolean
}

/** GET /api/team/members. `branches: []` means every branch. */
export type TeamMember = {
  _id: string
  user: { _id: string; name: string; email: string } | null
  role: TeamRole
  branches: BranchRef[]
  isYou: boolean
  joinedAt: string
}

/** GET /api/team/invites (pending only). `branches: []` means every branch. */
export type Invite = {
  _id: string
  email: string
  role: TeamRole
  branches: BranchRef[]
  status: "pending" | "accepted" | "revoked"
  /** Still pending, but past `expiresAt`. */
  expired: boolean
  expiresAt: string
  lastSentAt: string
  invitedBy: { _id: string; name: string } | null
  createdAt: string
}

export type RoleInfo = {
  role: TeamRole
  label: string
  permissions: Permission[]
  /** Can be given through an invite or a role change (everything except owner). */
  assignable: boolean
  /** Always covers every branch (owner, admin). */
  businessWide: boolean
}

/** GET /api/team/roles */
export type RolesResponse = { roles: RoleInfo[]; permissions: { key: Permission; label: string }[] }

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired"

/** GET /api/invites/:token (public). */
export type InvitePreview = {
  email: string
  role: TeamRole
  roleLabel: string
  business: { _id?: string; name?: string }
  /** `[]` means every branch. */
  branches?: BranchRef[]
  invitedBy: string | null
  expiresAt: string
  status: InviteStatus
  accountExists: boolean
}

/** POST /api/invites/:token/accept. Register also returns `accessToken` and `user`. */
export type InviteAccepted = {
  business: { _id: string; name: string; status: BusinessStatus }
  membership: Membership
}

// ---- Transactions ----

export type TransactionStatus = "pending" | "success" | "failed" | "reversed"
export type TransactionDirection = "credit" | "debit"

/** GET /api/transactions items. Money is integer kobo. */
export type Transaction = {
  _id: string
  type: "inbound_transfer" | "payout" | (string & {})
  direction: TransactionDirection
  amountKobo: number
  feeKobo: number
  netKobo: number
  currency: "NGN"
  status: TransactionStatus
  counterparty: { name?: string; bankName?: string; accountNumber?: string }
  narration: string | null
  reference: string | null
  occurredAt: string
  branch: BranchRef | null
  account: { _id: string; label: string; accountNumber: string; bankName?: string } | null
  /** Payouts: the transfer they belong to. */
  transfer?: string | null
}

export type TransactionList = { items: Transaction[]; total: number; skip: number; take: number }

/** GET /api/transactions/summary: successful transactions only. */
export type TransactionSummary = {
  inflowKobo: number
  outflowKobo: number
  feesKobo: number
  count: number
  currency: "NGN"
}

/**
 * GET /api/transactions/statement?branch=&from=&to=&format= answers with the file itself (docs/briefs/statements.md):
 * one branch account's completed transactions over Lagos days `from` to `to` (both included, at most 366, ending
 * today or earlier), with totals, and opening and closing balances where the bank reported them.
 */
export type StatementFormat = "pdf" | "csv"

// ---- Transfers ----

export type TransferKind = "bank" | "internal" | "linkpay"
export type TransferStatus = "pending_approval" | "rejected" | "cancelled" | "processing" | "success" | "failed"

/** GET /api/transfers items. Money is integer kobo: the recipient gets `amountKobo`, the account pays `totalKobo`. */
export type Transfer = {
  _id: string
  kind: TransferKind
  status: TransferStatus
  amountKobo: number
  /** Includes `stampDutyKobo`. */
  feeKobo: number
  stampDutyKobo: number
  totalKobo: number
  currency: "NGN"
  branch: BranchRef | null
  batch: string | null
  recipient: {
    accountNumber: string
    accountName: string
    bankName: string | null
    branch: BranchRef | null
    /** The saved beneficiary paid, if any (docs/briefs/bulk-payouts.md). */
    beneficiary?: string | null
  }
  narration: string | null
  reference: string
  failureReason: string | null
  createdBy: { _id: string; name: string } | null
  /** The final approval or the rejection; stays null while the transfer moves between levels. */
  decision: { by: { _id: string; name: string } | null; at: string; note: string | null } | null
  /** Approval levels and where each stands; null when it didn't need approval. */
  approval: TransferApproval | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
  /** The signed-in member is an approver at the current level (never their own, never two levels). */
  canApprove: boolean
  /** The signed-in member created it and it's still waiting for approval. */
  canCancel: boolean
}

export type ApprovalLevelStatus = "approved" | "waiting" | "upcoming" | "rejected" | "cancelled" | "not_reached"

export type TransferApprovalLevel = {
  /** 1-based. */
  level: number
  /** Anyone who can approve transfers clears it; `approvers` is then empty. */
  any: boolean
  approvers: { _id: string; name: string }[]
  status: ApprovalLevelStatus
  approvedBy: { _id: string; name: string } | null
  approvedAt: string | null
  note: string | null
}

/** A transfer's approval levels. `current` is the 1-based level waiting for a decision, null when not waiting. */
export type TransferApproval = { current: number | null; levels: TransferApprovalLevel[] }

export type TransferList = { items: Transfer[]; total: number; skip: number; take: number }

/** The fields a bulk transfer has both on its own (GET /api/transfers/batches/:id) and in GET /api/transfers/batches. */
export type TransferBatchHead = {
  _id: string
  title: string | null
  /** The payout list it was run from, if any. */
  payoutList?: string | null
  branch: BranchRef | null
  createdBy: { _id: string; name: string } | null
  count: number
  amountKobo: number
  feeKobo: number
  totalKobo: number
  createdAt: string
  statusCounts: Record<TransferStatus, number>
  /**
   * Rows the signed-in member can approve or reject now: waiting at a level that's open to anyone or names them,
   * not their own, no earlier level of it approved by them, from one of their branches.
   */
  awaitingMe: number
  /** What the `awaitingMe` rows send in all (their `amountKobo`, before fees). */
  awaitingMeKobo: number
}

export type TransferBatch = TransferBatchHead & { items: Transfer[] }

/**
 * What the member saw waiting for them in a bulk transfer, sent as `expect` with approve and reject: if it isn't
 * what waits for them now, nothing is decided (409 BATCH_CHANGED, with what waits now as `details`).
 */
export type BatchExpectation = { count: number; amountKobo: number }

/**
 * POST /api/transfers/batches/:id/approve | reject: the batch now, plus `decided` (rows this request approved a
 * level of, or rejected) and `skipped` (rows that were waiting but weren't decided: at other levels, for other
 * approvers, or decided by someone else at the same moment).
 */
export type TransferBatchDecision = TransferBatch & { decided: number; skipped: number }

/** Where a bulk transfer's waiting rows are: `waiting` rows at 1-based `level` of `of`, `awaitingMe` of them for the member. */
export type TransferBatchLevel = { level: number; of: number; waiting: number; awaitingMe: number }

/** GET /api/transfers/batches: newest first, without rows. `levels` covers waiting rows only, lowest level first. */
export type TransferBatchSummary = TransferBatchHead & { levels: TransferBatchLevel[] }

export type TransferBatchList = { items: TransferBatchSummary[]; total: number; skip: number; take: number }

export type Bank = { uuid: string; name: string; code: string | null }

/** POST /api/transfers/resolve-account */
export type ResolvedAccount = {
  accountNumber: string
  accountName: string
  bankName: string | null
  kind: TransferKind
  /** The branch (internal) or business (LinkPay) behind the account. */
  label: string | null
}

/** GET /api/transfers/fee */
export type FeeQuote = {
  amountKobo: number
  feeKobo: number
  stampDutyKobo: number
  totalKobo: number
  needsApproval: boolean
  /** How many approvals it would need; 0 goes straight away. */
  approvalLevels: number
}

/** POST /api/transfers/resolve-accounts: one result per row, in order. */
export type BulkResolvedRow =
  | ({ row: number; bankUuid: string } & ResolvedAccount)
  | { row: number; accountNumber: string; bankUuid: string; error: string; code?: string }

/** What's wrong with one bulk row (INVALID_ROWS `details.rows`, or a preview's `errors`). */
export type BulkRowError = {
  row: number
  error: string
  code?: string
  /** ACCOUNT_NAME_CHANGED: the name the bank gives the account now. */
  accountName?: string
}

/** POST /api/transfers/bulk/preview: a dry run of the batch. Nothing is created or held. */
export type BulkPreview = {
  branch: { _id: string; name: string; isHeadOffice: boolean }
  count: number
  amountKobo: number
  feeKobo: number
  stampDutyKobo: number
  totalKobo: number
  /** null when the balance couldn't be read just now. */
  availableKobo: number | null
  approval: {
    needed: boolean
    /** The amount that decided it: this batch plus what the member sent from the branch in the last 24 hours. */
    decidingKobo: number
    earlierKobo: number
    levels: { level: number; any: boolean; approvers: { _id: string; name: string }[] }[]
  }
  rows: {
    row: number
    accountNumber: string | null
    accountName: string | null
    bankName: string | null
    kind: TransferKind | null
    label: string | null
    beneficiary: string | null
    amountKobo: number
    feeKobo: number
    stampDutyKobo: number
    totalKobo: number
    narration: string | null
    error: string | null
    code: string | null
  }[]
  errors: BulkRowError[]
  /** What stops the whole batch: NO_APPROVER or INSUFFICIENT_BALANCE. */
  blockers: { error: string; code?: string; details?: Record<string, unknown> }[]
  ready: boolean
}

export type ApprovalMode = "never" | "always" | "above_threshold" | "workflow"

/** A person named at a workflow level. `canApprove` is false once they've left or lost the right to approve. */
export type WorkflowApprover = { _id: string; name: string; role: TeamRole | null; roleLabel: string | null; canApprove: boolean }

/** A transfer uses the highest tier it reaches; any one approver clears a level, and levels go in order. */
export type ApprovalTier = { minKobo: number; levels: { approvers: WorkflowApprover[] }[] }

/** GET /api/transfers/settings. `tiers` is empty unless the mode is "workflow". */
export type TransferSettings = { approval: { mode: ApprovalMode; thresholdKobo: number | null; tiers: ApprovalTier[] } }

/** GET /api/transfers/approvers: members who can be named at a level. `branches: null` means every branch. */
export type Approver = {
  _id: string
  name: string
  email: string
  role: TeamRole
  roleLabel: string
  branches: { _id: string; name: string }[] | null
}

// ---- Invoices ----

/** Stored statuses. "Overdue" isn't one: it's an unpaid invoice past its due date (`overdue`, `displayStatus`). */
export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "void"
export type PaymentMethod = "transfer" | "cash" | "pos" | "cheque" | "other"

export type InvoiceItem = { description: string; quantity: number; unitPriceKobo: number; amountKobo: number }

/** `value` is kobo for "amount" and basis points for "percent" (1000 = 10%). */
export type InvoiceDiscount = { type: "amount" | "percent"; value: number }

export type InvoiceCustomerDetails = {
  /** The saved customer this came from, if any. */
  ref: string | null
  name: string
  email: string | null
  phone: string | null
  address: string | null
}

export type InvoicePayment = {
  _id: string
  amountKobo: number
  method: PaymentMethod
  /** The incoming transfer this payment is, when it is one. */
  transaction: string | null
  /** Matched automatically from the transfer's narration. */
  auto: boolean
  note: string | null
  paidAt: string
  recordedBy: { _id: string; name: string } | null
}

/** The account the customer pays into: the invoice branch's. */
export type PayTo = { accountNumber: string; accountName: string | null; bankName: string | null }

/** GET /api/invoices items. Dates are Lagos calendar days, "YYYY-MM-DD". */
export type InvoiceListItem = {
  _id: string
  number: string
  status: InvoiceStatus
  displayStatus: InvoiceStatus | "overdue"
  overdue: boolean
  daysOverdue: number
  branch: BranchRef | null
  customer: InvoiceCustomerDetails
  issueDate: string
  dueDate: string
  currency: "NGN"
  totalKobo: number
  paidKobo: number
  balanceKobo: number
  issuedAt: string | null
  lastSentAt: string | null
  viewedAt: string | null
  paidAt: string | null
  createdAt: string
}

/** GET /api/invoices/:id */
export type Invoice = InvoiceListItem & {
  items: InvoiceItem[]
  subtotalKobo: number
  discount: InvoiceDiscount | null
  discountKobo: number
  /** Basis points (750 = 7.5%), null when there's no VAT. */
  vatRateBps: number | null
  vatKobo: number
  notes: string | null
  terms: string | null
  footer: string | null
  payments: InvoicePayment[]
  lastSentTo: string | null
  voidedAt: string | null
  receiptSentAt: string | null
  reminders: { enabled: boolean; sent: string[]; lastSentAt: string | null }
  /** The customer's page, `${WEB_URL}/i/<token>`; null while it's a draft. */
  publicUrl: string | null
  payTo: PayTo | null
  createdBy: { _id: string; name: string } | null
}

export type InvoiceList = { items: InvoiceListItem[]; total: number; skip: number; take: number }

/** GET /api/invoices/summary */
export type InvoiceSummary = {
  outstandingKobo: number
  overdueKobo: number
  unpaidCount: number
  overdueCount: number
  collectedThisMonthKobo: number
  counts: Record<InvoiceStatus, number>
  currency: "NGN"
}

/** GET /api/invoices/defaults: what a new invoice starts with. */
export type InvoiceDefaults = {
  issueDate: string
  dueDate: string
  /** Null unless VAT is on by default. */
  vatRateBps: number | null
  defaultVatRateBps: number
  notes: string | null
  terms: string | null
  footer: string | null
  nextNumber: string
}

/** GET /api/invoices/:id/suggested-payments items: incoming transfers that look like they're for it. */
export type SuggestedPayment = {
  _id: string
  amountKobo: number
  counterparty: { name?: string; bankName?: string }
  narration: string | null
  reference: string | null
  occurredAt: string
  /** The amount is exactly what's still owed. */
  exactAmount: boolean
}

export type InvoiceCustomer = { _id: string; name: string; email: string | null; phone: string | null; address: string | null }

/** Colours for the business's documents, worked out by the backend from its accent colour. */
export type BrandPalette = {
  /** Bands and fills. */
  accent: string
  /** Text on `accent`. */
  onAccent: string
  /** Accent-coloured text on white, darkened until it's readable. */
  accentText: string
}

/** GET /api/branding */
export type Branding = {
  logo: { url: string; width: number; height: number } | null
  accentColor: string | null
  palette: BrandPalette
  invoice: {
    prefix: string
    defaultDueDays: number
    vatRateBps: number
    vatByDefault: boolean
    notes: string | null
    terms: string | null
    footer: string | null
  }
}

/** GET /api/public/invoices/:token: what the customer sees, without signing in. */
export type PublicInvoice = {
  business: {
    name: string
    email: string | null
    phone: string | null
    address: string | null
    logo: { url: string; width: number; height: number } | null
    palette: BrandPalette
  }
  invoice: Pick<
    Invoice,
    | "number"
    | "status"
    | "displayStatus"
    | "overdue"
    | "issueDate"
    | "dueDate"
    | "customer"
    | "items"
    | "currency"
    | "subtotalKobo"
    | "discountKobo"
    | "vatRateBps"
    | "vatKobo"
    | "totalKobo"
    | "paidKobo"
    | "balanceKobo"
    | "paidAt"
    | "notes"
    | "terms"
    | "footer"
  > & {
    discountPercentBps: number | null
    payments: { amountKobo: number; method: PaymentMethod; paidAt: string }[]
  }
  /** Only while it's unpaid. */
  payTo: PayTo | null
  receiptAvailable: boolean
}

/** Kinds of in-app notification a business user gets (backend `src/config/notifications.ts`). */
export type NotificationType =
  | "transfer.approval_requested"
  | "transfer.approved"
  | "transfer.rejected"
  | "transfer.completed"
  | "transfer.failed"
  | "payment.received"
  | "payment_link.paid"
  | "invoice.viewed"
  | "invoice.payment_received"
  | "invoice.paid"
  | "invoice.overdue"
  | "kyb.approved"
  | "kyb.changes_requested"
  | "kyb.rejected"
  | "account.ready"
  | "team.member_joined"
  | "team.role_changed"
  | "team.removed"
  | "security.new_sign_in"
  | "savings.target_reached"
  | "savings.safelock_released"
  | "business.suspended"
  | "business.reinstated"
  | "business.banned"

/** One notification, across all the user's businesses. `link` is a path in this app. */
export type AppNotification = {
  _id: string
  type: NotificationType
  title: string
  body: string
  link: string | null
  /** The business it's about; null for account-wide ones (a new sign-in). */
  business: { _id: string; name: string | null } | null
  data: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

/** GET /api/notifications: newest first; pass `nextBefore` as `before` for the next page. */
export type NotificationPage = { items: AppNotification[]; nextBefore: string | null }

/** GET /api/notifications/unread-count */
export type UnreadCount = { total: number; byBusiness: Record<string, number> }

// ---------------------------------------------------------------------------------------------------------
// Savings pockets (/api/pockets). Contract: docs/briefs/savings.md.

export type PocketColor = "lime" | "green" | "teal" | "blue" | "violet" | "pink" | "orange" | "amber" | "slate"

/** Icon keys the API accepts. `POCKET_ICONS` in lib/savings maps each to a Lucide icon. */
export type PocketIcon =
  | "savings" | "tax" | "payroll" | "rent" | "shop" | "stock" | "delivery" | "power" | "repairs" | "equipment"
  | "vehicle" | "travel" | "marketing" | "growth" | "emergency" | "loan" | "training" | "health" | "events" | "goal"

export type PocketTarget = {
  amountKobo: number
  /** YYYY-MM-DD (Lagos). */
  date: string | null
  /** When the balance first reached the amount; null again if it drops below. */
  reachedAt: string | null
  /** 0..10000, capped at 10000. */
  progressBps: number
  remainingKobo: number
}

export type PocketAutoSave =
  | { percentBps: number; amountKobo: null; since: string }
  | { percentBps: null; amountKobo: number; since: string }

/** Money set aside inside one branch's account. */
export type Pocket = {
  _id: string
  name: string
  /** null shows the savings icon. */
  icon: PocketIcon | null
  color: PocketColor
  status: "active" | "closed"
  branch: BranchRef | null
  balanceKobo: number
  currency: "NGN"
  target: PocketTarget | null
  autoSave: PocketAutoSave | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
  closedAt: string | null
  /** The member has savings.manage and the pocket is open. */
  canManage: boolean
}

/** GET /api/pockets. `savedKobo` sums the open pockets in the list. */
export type PocketList = { items: Pocket[]; savedKobo: number; currency: "NGN" }

export type PocketMovement = {
  _id: string
  kind: "deposit" | "withdrawal" | "auto_save" | "close"
  direction: "in" | "out"
  amountKobo: number
  balanceAfterKobo: number
  note: string | null
  /** auto_save: the incoming payment it came from. */
  transaction: string | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
}

export type PocketActivity = { items: PocketMovement[]; nextBefore: string | null }

// ---- Safelock ----

/**
 * A fixed amount of a branch's available balance locked until `unlockOn` (a Lagos calendar day). It can't be
 * broken early, topped up or changed, except for its title. No interest yet.
 */
export type Safelock = {
  _id: string
  title: string
  status: "locked" | "released"
  branch: BranchRef | null
  amountKobo: number
  currency: "NGN"
  /** YYYY-MM-DD (Lagos). */
  lockedOn: string
  unlockOn: string
  /** The moment it unlocks (midnight Lagos). */
  unlockAt: string
  totalDays: number
  /** 0 once released. */
  daysLeft: number
  /** 0..10000: how far through the lock period. */
  progressBps: number
  releasedAt: string | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
  /** `savings.manage` and still locked. */
  canRename: boolean
}

/** GET /api/safelocks. `lockedKobo` sums the running locks in the list. */
export type SafelockList = { items: Safelock[]; lockedKobo: number; currency: "NGN" }

/** GET /api/safelocks/limits. Dates are YYYY-MM-DD (Lagos). */
export type SafelockLimits = {
  minAmountKobo: number
  maxAmountKobo: number
  minDays: number
  maxDays: number
  earliestUnlockOn: string
  latestUnlockOn: string
  maxPerBranch: number
  canBreakEarly: false
  interestRateBps: number
}

// ---- Payment links (contract: docs/briefs/payment-links.md) ----

export type PhoneFieldMode = "off" | "optional" | "required"
export type PaymentLinkStatus = "active" | "inactive"
export type PaymentLinkUnavailableReason = "taken_down" | "inactive" | "expired" | "sold_out" | "account_not_ready"
/** "donation": a fundraiser (donor chooses, optional goal, public donor list). Contract: docs/briefs/donations.md. */
export type PaymentLinkKind = "payment" | "donation"

/**
 * A fundraiser's figures. Raised includes the few kobo that tell transfers apart. Test payments never count in
 * the link's own totals; on the public page they count while the link is in test mode (`testKobo` of raised).
 */
export type DonationProgress = {
  goalKobo: number | null
  raisedKobo: number
  donationsCount: number
  /** Floor of raised / goal, can pass 100; null without a goal. */
  percent: number | null
  lastDonationAt: string | null
  /** Public page only: how much of `raisedKobo` is simulated gifts (test mode). */
  testKobo?: number
}

/** One donation as anyone can see it: no email, and no name when the donor chose to stay anonymous. */
export type PublicDonation = {
  _id: string
  name: string | null
  anonymous: boolean
  amountKobo: number
  message: string | null
  paidAt: string | null
  /** A simulated gift, listed only while the fundraiser is in test mode. */
  test?: boolean
}
export type PublicDonationPage = { items: PublicDonation[]; nextBefore: string | null }
export type DonationSort = "recent" | "top"
/** GET /api/public/pay/:slug/donations */
export type PublicDonationFeed = PublicDonationPage & { progress: DonationProgress }
export type CheckoutStatus = "pending" | "expired" | "paid" | "underpaid"
export type CheckoutSource = "page" | "embed"
/** "test": placeholder bank details and simulated payments, never counted in totals (brief §6). */
export type PaymentMode = "live" | "test"

export type PaymentLinkField = { _id: string; label: string; required: boolean }

/**
 * A picture on a payment link (the first is the cover). `url` is an API path with no host:
 * `/api/payment-links/images/<id>` (signed in) or `/api/public/pay/<slug>/images/<id>?v=<n>` (public).
 */
export type PaymentLinkImage = { _id: string; url: string; width: number; height: number }

/** GET /api/payment-links/:id */
export type PaymentLink = {
  _id: string
  title: string
  description: string | null
  slug: string
  /** WEB_URL/pay/<slug> */
  url: string
  branch: BranchRef | null
  kind: PaymentLinkKind
  /** null = the payer chooses (at least `minAmountKobo`, if set). */
  amountKobo: number | null
  minAmountKobo: number | null
  /** Donation links only. */
  donation: (DonationProgress & { suggestedAmountsKobo: number[] }) | null
  /** LinkPay staff paused it; the business can't turn it back on. */
  takenDown: { at: string } | null
  currency: "NGN"
  phone: PhoneFieldMode
  customFields: PaymentLinkField[]
  /** Up to 4, in order; the first is the cover. */
  images: PaymentLinkImage[]
  successMessage: string | null
  redirectUrl: string | null
  status: PaymentLinkStatus
  mode: PaymentMode
  /** Websites that may embed it; [] = any site. */
  allowedOrigins: string[]
  expiresAt: string | null
  maxPayments: number | null
  /** Live payments only. */
  paymentsCount: number
  collectedKobo: number
  lastPaidAt: string | null
  /** While in test mode: what simulated payments came to, shown beside the real figures. null when live. */
  test: { collectedKobo: number; paymentsCount: number } | null
  available: boolean
  unavailableReason: PaymentLinkUnavailableReason | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
  updatedAt: string
  canManage: boolean
}

export type PaymentLinkList = { items: PaymentLink[]; total: number; skip: number; take: number }

export type PaymentLinkSummary = {
  links: { active: number; inactive: number }
  collectedKobo: number
  paymentsCount: number
  last30Days: { collectedKobo: number; paymentsCount: number }
  /** Simulated payments on links that are in test mode (never in the totals above). */
  test: { collectedKobo: number; paymentsCount: number }
  currency: "NGN"
}

/** GET /api/payment-links/:id/embed: code to paste into the business's website. */
export type PaymentLinkEmbed = {
  url: string
  scriptUrl: string
  button: string
  inline: string
  javascript: string
  allowedOrigins: string[]
  /** API_URL/api/public/pay/<slug>/checkouts/{token}: answers only for this link's checkouts. */
  verifyUrl: string
  /** The link's mode now; the verify call returns each checkout's own. */
  mode: PaymentMode
}

/** A payer's checkout as the team sees it (GET /api/payment-links/checkouts). */
export type LinkCheckout = {
  _id: string
  reference: string
  status: CheckoutStatus
  /** Paid after the link had reached its payment limit: the business refunds it or honours it. */
  overLimit?: boolean
  /** The link's mode when the checkout started. */
  mode: PaymentMode
  link: { _id: string; title: string; slug: string } | null
  branch: BranchRef | null
  payer: { name: string; email: string; phone: string | null; fields: { label: string; value: string }[] }
  /** Donation links: hidden name on the public list, and their message. */
  donor: { anonymous: boolean; message: string | null } | null
  /** LinkPay staff took this donation off the public list. */
  hiddenFromPage: boolean
  priceKobo: number
  /** What the payer was asked to send: the price plus 1 to 99 kobo. */
  amountKobo: number
  currency: "NGN"
  paidKobo: number | null
  paidAt: string | null
  source: CheckoutSource
  embedOrigin: string | null
  /** The business's own order id, from its website. */
  clientReference: string | null
  metadata: Record<string, string>
  matchedBy: "amount" | "reference" | "manual" | "simulated" | null
  matchedByUser: { _id: string; name: string } | null
  transaction: string | null
  expiresAt: string
  createdAt: string
  /** Never on test checkouts. */
  canMatch: boolean
  /** A pending test checkout, for members who manage links. */
  canSimulate: boolean
}

export type LinkCheckoutList = { items: LinkCheckout[]; total: number; skip: number; take: number }

/** GET /api/public/pay/:slug: what the payer sees. */
export type PublicPaymentLink = {
  business: { name: string; logo: { url: string; width: number; height: number } | null; palette: BrandPalette }
  link: {
    slug: string
    kind: PaymentLinkKind
    title: string
    description: string | null
    amountKobo: number | null
    minAmountKobo: number | null
    maxAmountKobo: number | null
    currency: "NGN"
    phone: PhoneFieldMode
    customFields: PaymentLinkField[]
    /** Up to 4, in order; the first is the cover. Show them through `/pay/<slug>/images/<id>`. */
    images: PaymentLinkImage[]
  }
  embed: { allowedOrigins: string[] }
  mode: PaymentMode
  /** Donation links: progress, quick picks and the first page of donors (newest first). */
  donation: (DonationProgress & { suggestedAmountsKobo: number[]; recent: PublicDonationPage }) | null
  available: boolean
  unavailableReason: PaymentLinkUnavailableReason | null
}

/** GET /api/public/checkouts/:token and POST /api/public/pay/:slug/checkouts. */
export type PublicCheckout = {
  token: string
  reference: string
  status: CheckoutStatus
  /** "test": `payTo` is a placeholder and the page offers to simulate the payment. */
  mode: PaymentMode
  priceKobo: number
  /** Send exactly this. */
  /** null once the checkout's hold has passed: there's nothing left to send to. */
  amountKobo: number | null
  currency: "NGN"
  payTo: PayTo | null
  /** Paid after the link reached its payment limit: the business refunds it or honours it. */
  overLimit?: boolean
  expiresAt: string
  paidKobo: number | null
  paidAt: string | null
  payer: { name: string; email: string }
  source: CheckoutSource
  clientReference: string | null
  metadata: Record<string, string>
  /** `image` is the link's cover picture. */
  link: { slug: string; title: string; kind: PaymentLinkKind; image: PaymentLinkImage | null }
  /** Donation links: how the donation shows on the page. */
  donor: { anonymous: boolean; message: string | null } | null
  business: PublicPaymentLink["business"]
  successMessage: string | null
  redirectUrl: string | null
}

// ---- Beneficiaries and payout lists (docs/briefs/bulk-payouts.md) ----

/** A saved recipient: name-checked with the bank once, shared by every member. Only the nickname can change. */
export type Beneficiary = {
  _id: string
  accountNumber: string
  /** As the bank reported it when it was saved. */
  accountName: string
  bankName: string | null
  bankUuid: string
  /** Up to 60 characters. */
  nickname: string | null
  /** Another business on LinkPay (when it was saved). */
  onLinkPay: boolean
  /** Set when a transfer to it is created. */
  lastPaidAt: string | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
}

/** GET /api/beneficiaries: most recently paid first, then by name. */
export type BeneficiaryList = { items: Beneficiary[]; total: number; skip: number; take: number }

/** A payout list that uses a beneficiary (GET /api/beneficiaries/:id, BENEFICIARY_IN_USE `details.payoutLists`). */
export type PayoutListRef = { _id: string; title: string }

/** GET /api/beneficiaries/:id: the beneficiary and the payout lists that pay it, of those the member's branches can see. */
export type BeneficiaryDetail = Beneficiary & { payoutLists: PayoutListRef[] }

/** One row of POST /api/beneficiaries/import, by its index in the request. `created: false` was already saved. */
export type BeneficiaryImportRow =
  | { row: number; created: boolean; beneficiary: Beneficiary }
  | { row: number; error: string; code: string | null }

/**
 * POST /api/beneficiaries/import: good rows are saved even when others fail. A bank outage comes back on the
 * rows it hit as NAME_CHECK_UNAVAILABLE (and on the rest once several in a row have), to check again later.
 */
export type BeneficiaryImportResult = { created: number; failed: number; rows: BeneficiaryImportRow[] }

/** A row of a payout list. `beneficiary` is null if the saved beneficiary has gone. */
export type PayoutListItem = {
  /** With its bank's uuid: a run's Idempotency-Key follows each row's account number and bank. */
  beneficiary: Pick<Beneficiary, "_id" | "accountName" | "nickname" | "accountNumber" | "bankName" | "bankUuid"> | null
  amountKobo: number
  narration: string | null
}

/** GET /api/payout-lists items (no `items`); GET /:id, POST and PATCH add `items`. */
export type PayoutList = {
  _id: string
  /** 1 to 80 characters. */
  title: string
  /** The account it pays from by default; null means "choose each time". */
  branch: BranchRef | null
  count: number
  /** Before fees. */
  amountKobo: number
  lastRunAt: string | null
  /** The bulk transfer the last run made (null when the last run was a single transfer). */
  lastBatch: string | null
  /** The transfer the last run made when it paid one person (no batch); null otherwise. */
  lastTransfer: string | null
  createdBy: { _id: string; name: string } | null
  createdAt: string
  updatedAt: string
  items?: PayoutListItem[]
}

export type PayoutListWithItems = PayoutList & { items: PayoutListItem[] }

/** POST /api/payout-lists/:id/run, like POST /api/transfers/bulk: a batch, or one plain transfer for a single row. */
export type PayoutListRunResult = { batch: (TransferBatch & { payoutList?: string | null }) | null; items?: Transfer[] }
