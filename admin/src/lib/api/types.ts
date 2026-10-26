// Response shapes from the backend (`backend/src/models`, `backend/src/controllers`).
import type {
  BusinessStatus,
  BusinessType,
  DocumentType,
  IdType,
  PersonRole,
} from "@/lib/kyb"

export type TwoFactorMethod = "totp" | "email"

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

/** Bank account setup with the banking partner (Liquifia/Pouch). */
export type AccountSetupStatus = "not_started" | "pending" | "active" | "failed"
export type LiquifiaInfo = { accountStatus: AccountSetupStatus; customerId?: string; lastError?: string }

/** A business bank account (NGN virtual account), one per branch. Money is always integer kobo. */
export type Account = {
  _id: string
  branch?: BranchRef | string
  label: string
  accountNumber: string
  accountName?: string
  bankName?: string
  currency: "NGN"
  status: string
  createdAt: string
}

export type BranchRef = { _id: string; name: string; isHeadOffice: boolean }

/** A branch's own account details. */
export type BranchAccount = {
  id: string
  accountNumber: string
  accountName?: string
  bankName?: string
  currency: "NGN"
}

/** The head office is created on approval; each branch gets its own account. */
export type Branch = BranchRef & {
  business: string
  address?: Address
  manager?: { name?: string; email?: string; phone?: string }
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
  /** The staff member who last reviewed it. Absent for reviews from before staff accounts. */
  reviewedBy?: { _id: string; name: string; email: string }
  liquifia?: LiquifiaInfo
  /** Staff-only compliance state. Older businesses may not have it yet (read as active). */
  compliance?: BusinessCompliance
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

/** GET /api/admin/businesses/:id */
export type Overview = {
  business: Business
  documents: KybDocument[]
  /** Account details without balances. Empty until the account is set up. */
  accounts: Account[]
  /** Head office first. Empty until the business is approved. */
  branches: Branch[]
  checklist: Checklist
}

// ---- Staff (GET /api/admin/auth/me and the sign-in steps) ----

/** Staff roles from backend/src/config/staffPermissions.ts. Code checks permissions, never role names. */
export type StaffRole = "super_admin" | "compliance" | "operations" | "support"

export type StaffPermission =
  | "businesses.view"
  | "documents.view"
  | "kyb.review"
  | "accounts.provision"
  | "transactions.sync"
  | "users.view"
  | "activity.view"
  | "compliance.view"
  | "compliance.manage"
  | "compliance.ban"
  | "security.review"
  | "staff.manage"

/** Two-step is mandatory for staff: only the method changes. */
export type Staff = {
  _id: string
  name: string
  email: string
  role: StaffRole
  permissions: StaffPermission[]
  status: "active" | "disabled"
  twoFactor: { method: TwoFactorMethod }
  lastSignInAt: string | null
  createdAt: string
}

/** GET /api/admin/staff/roles */
export type StaffRoleInfo = { role: StaffRole; label: string; description: string; permissions: StaffPermission[] }

/** GET /api/admin/staff */
export type StaffMember = Staff & { invitedBy: { _id: string; name: string } | null; isYou: boolean }

/** GET /api/admin/staff/invites (open invites only) */
export type StaffInvite = {
  _id: string
  email: string
  role: StaffRole
  roleLabel: string
  status: "pending" | "accepted" | "revoked" | "expired"
  expiresAt: string
  lastSentAt: string
  invitedBy: { _id: string; name: string } | null
  createdAt: string
}

/** GET /api/admin/auth/invites/:token */
export type StaffInvitePreview = {
  email: string
  role: StaffRole
  roleLabel: string
  invitedBy: { name: string | null }
  expiresAt: string
}

/** POST /api/admin/auth/login */
export type StaffChallenge = { challengeToken: string; method: TwoFactorMethod }

/** POST /api/admin/auth/login/2fa */
export type StaffSession = { accessToken: string; expiresAt: string; staff: Staff }

export type AdminSummary = {
  counts: Record<BusinessStatus, number>
  total: number
  /** Approved businesses whose bank account setup failed. */
  accountSetupFailed: number
  compliance: { flagged: number; suspended: number; banned: number }
}

export type AdminBusinessList = {
  items: (Business & { owner: Owner })[]
  total: number
  skip: number
  take: number
}

// ---- Notifications (GET /api/admin/notifications) ----

/** One staff notification. `link` is a path in this app, e.g. "/businesses/<id>". */
export type AppNotification = {
  _id: string
  type:
    | "kyb.submitted"
    | "account.setup_failed"
    | "staff.invite_accepted"
    | "staff.role_changed"
    | "compliance.flag_raised"
    | "compliance.business_restricted"
    | "security.review_requested"
    | "security.reported"
    | (string & {})
  title: string
  body: string
  link: string | null
  business: { _id: string; name: string | null } | null
  data: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

/** Newest first; pass `nextBefore` as `before` for the next page (null when there are no more). */
export type NotificationPage = { items: AppNotification[]; nextBefore: string | null }

// ---- Compliance (docs/briefs/compliance.md) ----

/** `banned` is shown to staff as "Closed". */
export type ComplianceStatus = "active" | "suspended" | "banned"
export type FlagSeverity = "low" | "medium" | "high"
export type FlagCategory = "suspicious_transactions" | "fraud_report" | "identity_concern" | "sanctions" | "account_security" | "other"
export type FlagOutcome = "cleared" | "actioned"
export type StaffRef = { _id: string; name: string }

/** The counters kept on each business, as the business list returns them. */
export type BusinessCompliance = {
  status?: ComplianceStatus
  openFlags?: number
  highestOpenSeverity?: FlagSeverity | null
  lastFlaggedAt?: string | null
}

/** GET /api/admin/businesses/:id/compliance → compliance. Reason, note, since and by are null while active. */
export type ComplianceState = {
  status: ComplianceStatus
  reason: FlagCategory | null
  reasonLabel: string | null
  note: string | null
  since: string | null
  by: StaffRef | null
  openFlags: number
  highestOpenSeverity: FlagSeverity | null
  lastFlaggedAt: string | null
}

export type Flag<Evidence = FlagEvidenceIds> = {
  _id: string
  business: { _id: string; name?: string; status?: BusinessStatus; compliance?: ComplianceStatus }
  source: "rule" | "staff"
  rule: string | null
  ruleLabel: string | null
  category: FlagCategory
  categoryLabel: string
  severity: FlagSeverity
  summary: string
  note: string | null
  evidence: Evidence
  status: "open" | "resolved"
  raisedBy: StaffRef | null
  resolution: { outcome: FlagOutcome | null; note: string | null; by: StaffRef | null; at: string | null } | null
  createdAt: string
  updatedAt: string
}

export type FlagEvidenceIds = { transactions: string[]; transfers: string[]; metrics: Record<string, unknown> }

/** GET /api/admin/compliance/flags/:id: the evidence expanded to full items. */
export type FlagDetail = Flag<{ transactions: Transaction[]; transfers: AdminTransfer[]; metrics: Record<string, unknown> }>

export type FlagList = { items: Flag[]; total: number; skip: number; take: number }

export type ComplianceSummary = {
  openFlags: { total: number; high: number; medium: number; low: number; fromRules: number; fromStaff: number }
  flaggedBusinesses: number
  suspended: number
  banned: number
  raisedLast7d: number
  resolvedLast7d: number
}

export type RiskRuleInfo = {
  key: string
  label: string
  description: string
  severity: FlagSeverity
  windowHours: number
  [threshold: string]: unknown
}

/** GET /api/admin/compliance/rules (also feeds the category and severity pickers). */
export type ComplianceRules = {
  rules: RiskRuleInfo[]
  categories: { key: FlagCategory; label: string }[]
  severities: FlagSeverity[]
  statuses: ComplianceStatus[]
}

export type AuditAction =
  | "kyb.approved"
  | "kyb.changes_requested"
  | "kyb.rejected"
  | "account.provision_retried"
  | "flag.raised"
  | "flag.resolved"
  | "note.added"
  | "business.suspended"
  | "business.reinstated"
  | "business.banned"
  | "business.unbanned"
  | "staff.invited"
  | "staff.invite_revoked"
  | "staff.role_changed"
  | "staff.disabled"
  | "staff.enabled"
  | "staff.signed_out"
  | "security.request_approved"
  | "security.request_rejected"
  | "money_out.frozen"
  | "money_out.unfrozen"
  | "user.hold_cleared"

/** One audit log entry. On a business's timeline `business` is its id; the audit log expands it. */
export type AuditEntry<B = string | null> = {
  _id: string
  action: AuditAction
  summary: string
  actor: { type: "staff" | "system"; _id: string | null; name: string }
  business: B
  target: { kind: "business" | "flag" | "staff" | "staff_invite" | "branch"; _id: string } | null
  details: Record<string, unknown>
  createdAt: string
}

export type AuditPage = { items: AuditEntry<{ _id: string; name: string | null } | null>[]; nextBefore: string | null }

/** GET /api/admin/businesses/:id/compliance */
export type BusinessComplianceView = {
  business: { _id: string; name: string; status: BusinessStatus }
  compliance: ComplianceState
  flags: Flag[]
  timeline: AuditEntry[]
  timelineNextBefore: string | null
}

// ---- Activity (activity.view) ----

export type TransactionStatus = "pending" | "success" | "failed" | "reversed"
export type TransactionDirection = "credit" | "debit"

/** A payment in or out, as the business API's /api/transactions returns it. */
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
  transfer: string | null
}

export type Paged<T> = { items: T[]; total: number; skip: number; take: number }

/** GET /api/admin/activity/transactions: every business's payments. */
export type FeedTransaction = Transaction & {
  business: { _id: string; name: string; compliance: ComplianceStatus; openFlags: number } | null
}

export type TransferStatus = "pending_approval" | "rejected" | "cancelled" | "processing" | "success" | "failed"
export type TransferKind = "bank" | "internal" | "linkpay"
type UserRef = { _id: string; name: string; email: string }

export type AdminTransfer = {
  _id: string
  business: string
  kind: TransferKind
  status: TransferStatus
  amountKobo: number
  feeKobo: number
  totalKobo: number
  currency: "NGN"
  branch: BranchRef | null
  batch: string | null
  recipient: {
    accountNumber: string
    accountName: string
    bankName: string | null
    /** Set when the recipient is a business on LinkPay. */
    business: string | null
    branch: BranchRef | null
  }
  narration: string | null
  reference: string
  failureReason: string | null
  /** Approved but not yet accepted by the bank partner, e.g. held while the business is suspended. */
  awaitingProvider: boolean
  providerError: string | null
  createdBy: UserRef | null
  decision: { by: UserRef | null; at: string; note: string | null } | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
}

type Flow = { kobo: number; count: number }
type Flows = { last24h: Flow; last7d: Flow; last30d: Flow }

/** GET /api/admin/businesses/:id/activity */
export type BusinessActivity = {
  business: { _id: string; name: string; status: BusinessStatus; compliance: ComplianceStatus }
  moneyIn: Flows
  moneyOut: Flows
  /** Days with activity in the last 30, oldest first. `day` is a Lagos date. */
  daily: { day: string; inKobo: number; outKobo: number }[]
  transfers: { last30d: Record<TransferStatus, { count: number; kobo: number }> }
  counterparties: { payers30d: number; recipients30d: number }
  accounts: {
    _id: string
    accountNumber: string
    accountName: string | null
    bankName: string | null
    branch: BranchRef | null
    /** Live from the bank partner; null when the lookup failed. */
    balanceKobo: number | null
  }[]
  team: { members: number }
  lastActivityAt: string | null
}

/** GET /api/admin/businesses/:id/members */
export type BusinessMembers = {
  members: {
    user: {
      _id: string
      name: string
      email: string
      emailVerified: boolean
      twoFactor: TwoFactorMethod | null
      lastSignInAt: string | null
      lastSignInIp: string | null
      createdAt: string
    }
    role: string
    roleLabel: string
    branches: { _id: string; name: string | null }[]
    joinedAt: string
    activeDevices: number
  }[]
  invites: { _id: string; email: string; role: string; roleLabel: string; expiresAt: string; createdAt: string }[]
}

// ---------------------------------------------------------------------------------------------------------
// Money-out security reviews (security.review). Contract: docs/briefs/money-out-security.md §4.
// ---------------------------------------------------------------------------------------------------------

export type SecurityRequestKind = "settlement_account" | "settlement_only_off"
export type SecurityRequestStatus = "pending" | "approved" | "completed" | "rejected" | "cancelled"
export type SecurityRisk = "low" | "medium" | "high"

export type SettlementNameCheck = {
  result: "match" | "partial"
  score: number
  matchedTo: "business" | "person"
  matchedName: string
  note?: string
}

export type AdminSettlementAccount = {
  _id: string
  accountNumber: string
  accountName: string
  bankName: string | null
  status: "pending" | "active" | "rejected" | "cancelled" | "removed"
  nameCheck: SettlementNameCheck
  createdAt: string
  activatedAt: string | null
  endedAt: string | null
  lastWithdrawalAt: string | null
}

export type SecuritySignals = {
  risk?: SecurityRisk
  reasons?: string[]
  nameCheck?: SettlementNameCheck
  requester?: {
    _id: string
    name: string | null
    email: string | null
    role: string | null
    memberSince?: string | null
    twoFactor: "totp" | "email" | null
    lastSignInAt?: string | null
    lastSignInIp?: string | null
  }
  ip?: string | null
  userAgent?: string | null
  twoFactorChangedAt?: string | null
  failedCodes7d?: number
  newDevices7d?: number
  settlementChanges30d?: number
  activeSettlementAccounts?: number
  firstEver?: boolean
  paidBefore?: number
  sharedWith?: { _id: string; name: string }[]
}

export type SecurityRequest = {
  _id: string
  kind: SecurityRequestKind
  status: SecurityRequestStatus
  business: { _id: string; name: string; type: string; frozen: boolean } | null
  settlementAccount: AdminSettlementAccount | null
  requestedBy: { _id: string; name: string; email: string } | null
  ip: string | null
  userAgent: string | null
  availableAt: string
  createdAt: string
  completedAt: string | null
  signals: SecuritySignals
  review: { decision: "approved" | "rejected"; byName: string; at: string; note: string; callbackConfirmed: boolean } | null
  cancellation: { by: "member" | "report" | "staff"; byName: string; at: string; reason?: string } | null
}

export type SecurityEvent = { _id: string; type: string; summary: string; actor: { type: string; name: string }; ip: string | null; createdAt: string }

export type SecurityRequestDetail = SecurityRequest & {
  /** Call back on these: they come from the business's verification, never from the requester. */
  contacts: { businessEmail: string | null; businessPhone: string | null; people: { fullName: string; roles: string[]; phone: string | null; email: string | null }[] } | null
  settlementAccounts: AdminSettlementAccount[]
  events: SecurityEvent[]
}

export type SecuritySummary = { pending: number; coolingOff: number; frozen: number; reports30d: number }

export type SecurityRequestList = { items: SecurityRequest[]; total: number; skip: number; take: number }

export type BusinessSecurityView = {
  moneyOut: {
    frozen: { at: string; source: "member" | "report" | "staff"; byName: string | null; reason: string | null } | null
    settlementOnly: { enabled: boolean; since: string | null }
  }
  settlementAccounts: AdminSettlementAccount[]
  requests: SecurityRequest[]
  events: SecurityEvent[]
}
