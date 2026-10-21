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
  twoFactor?: { enabled: boolean; method: TwoFactorMethod | null }
  createdAt: string
  updatedAt: string
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
 * and `availableKobo` is what can be sent. The last two are absent from older backends.
 */
export type Balance = { amountKobo: number; currency: "NGN"; heldKobo?: number; availableKobo?: number }

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
  createdAt: string
  updatedAt: string
}

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

/** Fixed roles today; custom roles may come later, so treat unknown names gracefully. */
export type TeamRole = "owner" | "admin" | "finance" | "approver" | "viewer" | (string & {})

/** `branches: null` means every branch. */
export type Membership = { _id: string; role: TeamRole; permissions: Permission[]; branches: string[] | null }

/** GET /api/memberships: every business the user belongs to, for the business switcher. */
export type MembershipSummary = {
  business: { _id: string; name: string; status: BusinessStatus }
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
  recipient: { accountNumber: string; accountName: string; bankName: string | null; branch: BranchRef | null }
  narration: string | null
  reference: string
  failureReason: string | null
  createdBy: { _id: string; name: string } | null
  decision: { by: { _id: string; name: string } | null; at: string; note: string | null } | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
  /** The signed-in member can approve or reject it (never their own). */
  canApprove: boolean
  /** The signed-in member created it and it's still waiting for approval. */
  canCancel: boolean
}

export type TransferList = { items: Transfer[]; total: number; skip: number; take: number }

export type TransferBatch = {
  _id: string
  title: string | null
  count: number
  amountKobo: number
  feeKobo: number
  totalKobo: number
  createdAt: string
  statusCounts: Record<TransferStatus, number>
  items: Transfer[]
}

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
export type FeeQuote = { amountKobo: number; feeKobo: number; stampDutyKobo: number; totalKobo: number; needsApproval: boolean }

export type ApprovalMode = "never" | "always" | "above_threshold"
export type TransferSettings = { approval: { mode: ApprovalMode; thresholdKobo: number | null } }

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
