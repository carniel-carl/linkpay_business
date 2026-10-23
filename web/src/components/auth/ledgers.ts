// The facts under the auth band. Keep them true to what the product does today.

export type LedgerRow = { key: string; title: string; detail: string }
export type Ledger = { label: string; rows: LedgerRow[]; current?: string; numbered?: boolean }

const SIGN_IN_ROWS: LedgerRow[] = [
  { key: "password", title: "Password", detail: "Your email and the password you chose" },
  { key: "code", title: "Emailed code", detail: "A 6-digit code sent to your email, no password needed" },
  {
    key: "two-factor",
    title: "Two-step verification",
    detail: "If you turned it on, a second code from your authenticator app or email",
  },
]

const OPENING_ROWS: LedgerRow[] = [
  { key: "login", title: "Your login", detail: "Your name, work email and a password" },
  { key: "email", title: "Confirm your email", detail: "A 6-digit code, valid for 10 minutes" },
  { key: "business", title: "Your business", detail: "Business type, details, owners and directors" },
  {
    key: "documents",
    title: "Documents",
    detail: "CAC registration, TIN, directors' BVN and photo ID, proof of address",
  },
  { key: "review", title: "Review by LinkPay", detail: "Your branch accounts open once we approve" },
]

const TEAM_ROWS: LedgerRow[] = [
  { key: "sign-in", title: "Your own sign-in", detail: "Your own password, with two-step verification if you turn it on" },
  { key: "role", title: "Access set by your role", detail: "The owner or an admin decides what you can see and do" },
  { key: "branches", title: "Only the branches you need", detail: "Some roles see just the branches they work with" },
]

export const signInLedger = (current: "password" | "code" | "two-factor"): Ledger => ({
  label: "Ways to sign in",
  rows: SIGN_IN_ROWS,
  current,
})

export const openingLedger = (current: "login" | "email"): Ledger => ({
  label: "Opening an account",
  rows: OPENING_ROWS,
  current,
  numbered: true,
})

export const teamLedger: Ledger = { label: "How team access works", rows: TEAM_ROWS }

const RESET_ROWS: LedgerRow[] = [
  { key: "email", title: "Your email", detail: "We send a 6-digit code, valid for 10 minutes" },
  { key: "password", title: "A new password", detail: "The code and at least 8 characters" },
  { key: "sign-in", title: "Sign in again", detail: "Every device is signed out, so sign in with the new password" },
]

export const resetLedger = (current: "email" | "password" | "sign-in"): Ledger => ({
  label: "Resetting your password",
  rows: RESET_ROWS,
  current,
  numbered: true,
})
