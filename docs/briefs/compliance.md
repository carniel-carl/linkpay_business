# Brief: compliance and activity monitoring

Product owner's request, 2026-10-21: staff need to **keep track of what approved businesses are doing**, so a business involved in fraud can be **flagged, suspended or banned**. Until now the admin console only covered verification (KYB), bank account setup and staff.

**Backend: done 2026-10-21** (`tests/compliance.test.ts`, 19 tests). This brief is the contract for the `admin/` screens, plus the small changes the business `web/` and `mobile/` apps need. Try it with `bun run dev:mock --seed`: **Swift Gadgets Ltd** has two automatic flags; **Quick Cash Ventures** is flagged, has a note and is suspended (owners `swift@linkpay.test` and `quickcash@linkpay.test`, password `password123`). Sign in to admin/ as `compliance@linkpay.test` (reviewer) or `staff@linkpay.test` (super admin, the only role that can ban).

## 1. Concepts

| Thing | What it is |
| --- | --- |
| **Flag** | A concern for staff to look into. Raised by a staff member or by an **automatic risk rule**. Has a category, a severity (`low`, `medium`, `high`), a one-line summary, an optional note and evidence (payments, transfers, the rule's figures). Open until resolved as `cleared` (nothing wrong) or `actioned` (something was done). The business never sees flags. |
| **Suspended** | Temporary freeze. The business's team can sign in and **look** (every GET works) but **every change is refused** (`403 BUSINESS_SUSPENDED`): no transfers, approvals, invoices, branches, team changes or savings moves. Approved transfers the bank partner hasn't accepted yet are **held**, then sent once reinstated. Public invoice links return 404 and reminders stop. Payments into the account still land. |
| **Banned** (shown as "Closed") | The business is closed. **Every** business route is refused (`403 BUSINESS_BANNED`), transfers waiting for approval are cancelled, open team invites are revoked, other businesses can't send to its account (`RECIPIENT_UNAVAILABLE`), and it can't be resubmitted or approved. A ban can be lifted (back to active). What happens to money left in the account is a manual process for now (open question). |
| **Audit log** | Every staff action (KYB decisions, account setup retries, flags, notes, suspensions, bans, staff management) and every flag the rules raise, with who, when and the IP. Append-only. **Notes** on a business are audit entries (`note.added`), so a business has one timeline. |

The business is told **that** it's restricted (email, notification, `restriction` on `GET /api/business`), **never why**: no reason, note or flag text reaches it.

## 2. Automatic risk rules

Run every 5 minutes (every minute on `dev:mock`) and on demand (`POST /compliance/run-checks`). Thresholds live in `backend/src/config/compliance.ts`; `GET /compliance/rules` returns them for display.

| Rule | Flags when | Severity |
| --- | --- | --- |
| `large_amount` | A single payment in or out of ₦5,000,000 or more (24 h) | medium |
| `pass_through` | 80%+ of the money received in 24 h was sent out again in the same 24 h (₦1,000,000 received at least; own-branch moves don't count) | high |
| `transfer_velocity` | 20+ transfers started within an hour (a bulk transfer counts once) | medium |
| `new_recipients` | 15+ accounts paid for the first time within 24 h | medium |
| `new_business_volume` | ₦10,000,000+ received within 30 days of approval | medium |
| `failed_transfers` | 5+ transfers failed within 24 h | low |

A rule keeps at most **one open flag per business**. After it's resolved, only activity after the resolution counts, so the same payments never flag the business twice. Closed (banned) businesses aren't checked.

## 3. Permissions (in `staff.permissions`)

| Permission | Roles | Allows |
| --- | --- | --- |
| `activity.view` | all four | Activity overview, transactions, transfers and team of a business; the platform-wide payments feed |
| `activity.view_ips` | super admin, compliance | Members' last sign-in IP (`lastSignInIp`) on a business's Team tab. For everyone else the field is left out (2026-10-23) |
| `compliance.view` | super admin, compliance | Compliance page, flags, a business's compliance tab, the audit log |
| `compliance.manage` | super admin, compliance | Raise and resolve flags, add notes, suspend, reinstate, run the checks |
| `compliance.ban` | super admin | Ban and lift a ban |

Hide what the role can't use, as for the existing actions.

## 4. API (all under `/api/admin`, staff token)

### Activity (`activity.view`)

| Method and path | Response |
| --- | --- |
| `GET /businesses/:id/activity` | `{ business: { _id, name, status, compliance }, moneyIn, moneyOut, daily, transfers, counterparties, accounts, team, lastActivityAt }`. `moneyIn` / `moneyOut`: `{ last24h, last7d, last30d }`, each `{ kobo, count }` (in = successful payments; out = payouts the bank partner accepted). `daily`: `[{ day: "YYYY-MM-DD" (Lagos), inKobo, outKobo }]` for days with activity in the last 30. `transfers.last30d`: `{ <status>: { count, kobo } }` for every transfer status. `counterparties`: `{ payers30d, recipients30d }`. `accounts`: `[{ _id, accountNumber, accountName, bankName, branch: { _id, name, isHeadOffice }, balanceKobo \| null }]` (live, read-only; null if the lookup failed). `team: { members }` |
| `GET /businesses/:id/transactions?branch=&direction=credit\|debit&status=&from=&to=&minKobo=&q=&skip=&take=` | `{ items, total, skip, take }`; items as in the business API's `/api/transactions` |
| `GET /businesses/:id/transfers?status=&kind=&branch=&from=&to=&minKobo=&q=&skip=&take=` | `{ items, total, skip, take }`; item: `{ _id, kind, status, amountKobo, feeKobo, totalKobo, branch, batch, recipient: { accountNumber, accountName, bankName, business, branch }, narration, reference, failureReason, awaitingProvider, providerError, createdBy: { _id, name, email }, decision: { by, at, note } \| null, createdAt, submittedAt, completedAt }`. `awaitingProvider` + `providerError: "Held: the business is suspended"` marks held transfers |
| `GET /businesses/:id/members` | `{ members: [{ user: { _id, name, email, emailVerified, twoFactor: "totp"\|"email"\|null, lastSignInAt, lastSignInIp (only with `activity.view_ips`), createdAt }, role, roleLabel, branches: [{ _id, name }], joinedAt, activeDevices }], invites: [{ _id, email, role, roleLabel, expiresAt, createdAt }] }` |
| `GET /activity/transactions?business=&direction=&status=&from=&to=&minKobo=&q=&skip=&take=` | Every business's payments, newest first: the transaction items plus `business: { _id, name, compliance, openFlags }` |

### Compliance (`compliance.view` to read; writes as marked)

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /compliance/summary` | | `{ openFlags: { total, high, medium, low, fromRules, fromStaff }, flaggedBusinesses, suspended, banned, raisedLast7d, resolvedLast7d }` |
| `GET /compliance/rules` | | `{ rules: [{ key, label, description, severity, windowHours, ...thresholds }], categories: [{ key, label }], severities, statuses }` (feeds the forms) |
| `GET /compliance/flags?status=open\|resolved\|all&severity=&category=&rule=&source=rule\|staff&business=&skip=&take=` | | `{ items: [flag], total, skip, take }`. Open: highest severity first, then newest |
| `GET /compliance/flags/:id` | | flag, with `evidence.transactions` and `evidence.transfers` expanded to full items |
| `POST /compliance/flags/:id/resolve` (manage) | `{ outcome: "cleared"\|"actioned", note }` | flag. `409 FLAG_NOT_OPEN` |
| `POST /compliance/run-checks` (manage) | | `{ raised, byRule }` |
| `GET /businesses/:id/compliance` | | `{ business: { _id, name, status }, compliance: state, flags: [flag] (newest first, up to 100), timeline: [entry] (50 newest), timelineNextBefore }` |
| `POST /businesses/:id/flags` (manage) | `{ category, severity, summary (3–200), note?, transactionIds?, transferIds? }` | `201 flag`. `400 INVALID_EVIDENCE` if an id isn't this business's |
| `POST /businesses/:id/notes` (manage) | `{ body }` | `201 entry` |
| `POST /businesses/:id/suspend` (manage) | `{ reason: category, note }` | `{ business, compliance: state }`. `409 NOT_APPROVED`, `BUSINESS_SUSPENDED`, `BUSINESS_BANNED` |
| `POST /businesses/:id/reinstate` (manage) | `{ note }` | same. `409 BUSINESS_NOT_RESTRICTED`, `BUSINESS_BANNED` |
| `POST /businesses/:id/ban` (ban) | `{ reason: category, note }` | same. Works from active or suspended, and on businesses that aren't approved yet. `409 BUSINESS_BANNED` |
| `POST /businesses/:id/unban` (ban) | `{ note }` | same. `409 BUSINESS_NOT_RESTRICTED`, `BUSINESS_SUSPENDED` |
| `GET /audit?business=&staff=&action=&before=&take=` | | `{ items: [entry + business: { _id, name } \| null], nextBefore }`, newest first |

Shapes:
- **flag**: `{ _id, business: { _id, name, status, compliance }, source: "rule"\|"staff", rule, ruleLabel, category, categoryLabel, severity, summary, note, evidence: { transactions: id[], transfers: id[], metrics }, status: "open"\|"resolved", raisedBy: { _id, name } \| null, resolution: { outcome, note, by, at } \| null, createdAt, updatedAt }`
- **state**: `{ status: "active"\|"suspended"\|"banned", reason, reasonLabel, note, since, by: { _id, name }, openFlags, highestOpenSeverity, lastFlaggedAt }` (reason, note, since and by are null while active)
- **entry**: `{ _id, action, summary, actor: { type: "staff"\|"system", _id, name }, business, target: { kind, _id } \| null, details, createdAt }`. Actions: `kyb.approved`, `kyb.changes_requested`, `kyb.rejected`, `account.provision_retried`, `flag.raised`, `flag.resolved`, `note.added`, `business.suspended`, `business.reinstated`, `business.banned`, `business.unbanned`, `staff.invited`, `staff.invite_revoked`, `staff.role_changed`, `staff.disabled`, `staff.enabled`, `staff.signed_out`
- Categories: `suspicious_transactions`, `fraud_report`, `identity_concern`, `sanctions`, `other`

Existing endpoints, extended:
- `GET /businesses` takes `compliance=active|suspended|banned|flagged` and `sort=flags` (with `dir=desc`, most open flags first). Each business carries `compliance: { status, openFlags, highestOpenSeverity, lastFlaggedAt, ... }`.
- `GET /summary` adds `compliance: { flagged, suspended, banned }`.
- New staff notifications: `compliance.flag_raised` (to `compliance.manage` staff, except whoever raised it; link `/businesses/<id>/compliance?flag=<flagId>`) and `compliance.business_restricted` (to `compliance.view` staff except the actor; link `/businesses/<id>/compliance`).

## 5. admin/ screens (to build)

1. **Compliance** in the sidebar (`compliance.view`): summary tiles; the open-flags queue (severity chip, business, summary, source "Automatic" or the staff name, age), filters for severity, source, rule and status; a flag sheet with the evidence tables and Resolve (cleared or actioned, note required); "Run checks now". A short "Rules" panel from `GET /compliance/rules`.
2. **Business detail → new tabs**: **Activity** (`activity.view`: money in/out tiles for 24h / 7d / 30d, a 30-day in/out chart, account balances, transfers by status, then Transactions and Transfers tables with filters and `minKobo`, and Team with last sign-in, 2FA and devices) and **Compliance** (`compliance.view`: status banner with reason, note, who and when; Suspend / Reinstate (`compliance.manage`) and Close / Lift ban (`compliance.ban`) with a reason picker and required note, plus a clear confirmation saying what happens to the business; Flag this business; Add note; flags list; the timeline).
3. **Business list**: compliance filter tabs or chips (Flagged, Suspended, Closed), a severity dot on flagged rows, "Suspended" / "Closed" badges.
4. **Payments feed** (`activity.view`): `GET /activity/transactions` with filters (direction, amount from, dates, search), linking each row to its business.
5. **Audit log** (`compliance.view`): filters by action and staff, cursor paging.
6. Handle the two new notification types in the bell (icons and links).

## 6. web/ and mobile/ (small, to build)

- `GET /api/business` now returns `business.restriction: { status: "active"|"suspended"|"banned", since }`; `GET /api/memberships` items carry `business.restriction`.
- **Suspended**: a persistent banner ("Your business is suspended while we review its account. You can view your account but can't send money or make changes. Contact support."), and hide or disable write actions. Any write may answer `403 BUSINESS_SUSPENDED`: show its message instead of a generic error.
- **Banned**: every business route answers `403 BUSINESS_BANNED`. Show a closed screen (support contact) instead of the dashboard; keep sign-out and the business switcher for members of other businesses.
- New user notifications: `business.suspended`, `business.reinstated`, `business.banned` (push on the `account` channel, link `/dashboard`).
- The public invoice page already handles 404 (a restricted business's invoices return `INVOICE_NOT_FOUND`).

## Batch 9: what members see (2026-10-25)

The backend needed no change. `GET /api/business` returns `restriction: { status, since }`, even for a banned business. `GET /api/memberships` gives each business's `restriction` as a bare string (`active`, `suspended` or `banned`). `backend/tests/restrictionClients.test.ts` pins both.

- **Web, suspended.**
  - A banner under the header on every dashboard page: "<Business> is suspended. You can view your account, but you can't send money or make changes. Contact <support email>." A "Suspended" badge replaces "Verified".
  - The main write actions are dimmed, with that reason as a tooltip (`components/shell/write-gate.tsx`): send, bulk, invoices, payment links, savings, payout lists, beneficiaries, team and branches.
  - Anything else that reaches the server shows the mapped `BUSINESS_SUSPENDED` message.
- **Web, banned.**
  - The dashboard and onboarding layouts, and any `BUSINESS_BANNED` read (`lib/data.ts`), go to `/closed`. It offers the support contact, the member's other businesses with their states, and sign out.
  - It re-checks when the tab comes back into view, so a lifted ban returns to the dashboard.
- **Mobile.**
  - Suspended: Home shows a banner (tapping it emails support), and branch cards drop Send. Other write screens show the mapped error.
  - Banned: a full-screen closed overlay sits over the tabs, below the update and lock screens. It offers support, other businesses and sign out.
  - The business switcher tags Suspended or Closed. The overview refetches when a request is refused with either code, when the unread count rises, and on returning to the foreground while restricted.
- The email sent when a suspension or ban is lifted now reads "We've finished our review of <Business> and restored full access."

## Batch 10: every write gated, two exemptions (2026-10-25)

- **Web:**
  - The shared `Button` and `DropdownMenuItem` take a `write` prop (`components/ui/button.tsx`, `ui/dropdown-menu.tsx`; `AlertDialogAction` passes it through).
  - While the business is suspended, a `write` control is dimmed and stays focusable, with the "<Name> is suspended, so you can't do this right now" tooltip. Choosing a dimmed menu item does nothing, and a link item doesn't navigate.
  - Every business write is marked this way: transfers and approvals, beneficiaries, payout lists, invoices and branding, payment links, savings, team and branches.
- **Mobile:**
  - `useWriteGuard()`, `alertSuspended()` and `SuspendedNotice` live in `lib/restriction.ts`.
  - A `write` prop on `Button`, `TextButton`, `HeaderButton` and `ListRow` keeps the action visible. A tap shows an alert with the same sentence, "You can still see your balances and payments.", and OK or Email support.
  - Home's Send on branch cards is back, and explains itself when tapped.
  - Write screens opened from a link or a notification show the banner at the top.
- **Not gated:**
  - user-level settings: profile, password, 2FA, sessions, transaction PIN, notifications;
  - reads, downloads, copying and sharing;
  - onboarding;
  - automatic lookups inside a flow that's already past a gate.
- **Two backend exemptions** (`businessGate` in `middleware/roles.ts`):
  - `POST /api/team/leave` works while the business is suspended or closed. Leaving ends only the member's own access, and nobody should be kept in a business they want out of. The owner still can't leave.
  - `POST /api/transfers/:id/refresh` ("Check status now") works while suspended. It only asks the bank how a payout already sent is doing, as the payout follow-up does every minute. It stays refused for a closed business, like every other route.
  - The apps don't gate either button.
- **Leaving from the closed screens.**
  - Non-owners can leave from web `/closed` and from the mobile closed overlay; owners don't see the option.
  - The call names the closed business (web: the `businessId` option on `api()`), so it can't leave another one by mistake.
  - Afterwards the member moves to their next business, or to onboarding if they have none.
- **The banner on transfer and batch screens** shows only when the screen has a gated action. A processing transfer, whose only action is Check status, shows none.

