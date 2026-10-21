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
  type: "kyb.submitted" | "account.setup_failed" | "staff.invite_accepted" | "staff.role_changed" | (string & {})
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
