// Shapes returned by the backend (see docs/IMPLEMENTATION.md, section 4). Mirrors web/src/lib/api/types.ts.

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
  type?: string;
  registrationNumber?: string;
  tin?: string;
  industry?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: Address;
  status: BusinessStatus;
  reviewNote?: string;
  reviewedAt?: string;
  liquifia?: { accountStatus: AccountSetupStatus };
};

export type Permission =
  | "accounts.view"
  | "branches.manage"
  | "team.manage"
  | "transfers.create"
  | "transfers.approve"
  | "transfers.manage"
  | "invoices.manage";

/** `branches: null` means every branch. Decide from `permissions`, never from the role name. */
export type Membership = { _id: string; role: string; permissions: Permission[]; branches: string[] | null };

/** GET /api/business: the member's view of the business. Branches are head office first. */
export type Overview = { business: Business; branches: Branch[]; membership?: Membership };

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
  /** `availableKobo` (balance minus money held for pending transfers) arrives with Transfers; use it when present. */
  balance: { amountKobo: number; currency: "NGN"; heldKobo?: number; availableKobo?: number } | null;
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
  decision: { by: { _id: string; name: string } | null; at: string; note: string | null } | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  /** Waiting for approval, the member may approve, and someone else created it. */
  canApprove: boolean;
  /** Waiting for approval and the member created it. */
  canCancel: boolean;
};

export type TransferList = { items: Transfer[]; total: number; skip: number; take: number };

export type Bank = { uuid: string; name: string; code: string | null };

/** POST /api/transfers/resolve-account: the bank's name enquiry. `label` names the receiving LinkPay business or branch. */
export type ResolvedAccount = { accountNumber: string; accountName: string; bankName: string | null; kind: TransferKind; label: string | null };

/** GET /api/transfers/fee */
export type FeeQuote = { amountKobo: number; feeKobo: number; stampDutyKobo: number; totalKobo: number; needsApproval: boolean };

export type ApprovalRule = { mode: "never" | "always" | "above_threshold"; thresholdKobo: number | null };
