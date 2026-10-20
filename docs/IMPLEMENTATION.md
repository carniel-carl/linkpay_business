# LinkPay Business: implementation status and handoff

This is the single source of truth for **where the project is and what comes next**. Read it at the start of every session, and update it at the end: the status tables, the "Next up" section and the session log.

Last updated: 2026-10-20

---

## 1. Product

LinkPay Business is a **standalone business-banking product for Nigerian businesses**, modelled on the PiggyVest Business dashboard ([FAQ](https://piggyvestbusiness.com/faqs), [API docs](https://piggyvestbusiness.com/docs)).

Decisions made by the product owner:

| Decision | Detail |
| --- | --- |
| Standalone | **Not** linked to, or integrated with, the existing LinkPay product. It has separate accounts and no single sign-on. |
| Users | Businesses. They use the **web** dashboard (`web/`) or the **mobile** app (`mobile/`), both on the same backend API. |
| Country | Nigeria only (NGN) at launch. |
| Licensing | An existing bank partnership covers it, including interest-bearing products later. |
| Money rails | **Liquifia / Pouch fiat API** ([llms.txt](https://fiat-api.pouchfinance.xyz/llms.txt)). |
| Settlement | Incoming funds are **held** in each business's virtual account and form its spendable balance. |
| Wallet-to-wallet | Transfers between businesses on the platform are in scope. |
| Access gate | Sign up → submit verification (KYB) documents → admin approves → full app access. |
| Way of working | Build **one feature at a time**, end to end (backend, then web), and confirm before starting the next. |

---

## 2. Repository layout and running locally

```
linkpay_business/
├── backend/   Express 5 + MongoDB (Mongoose) on Bun. See backend/CLAUDE.md for conventions
├── web/       Next.js 16 (App Router) + Tailwind v4 + shadcn/ui. See web/DESIGN.md and web/AGENTS.md
├── mobile/    Expo SDK 58 + Expo Router + NativeWind. See mobile/CLAUDE.md
└── docs/      this file
```

> ⚠️ The project is **not a git repository** yet. Run `git init` and commit before any large change.

### Backend
```bash
cd backend
bun install
bun run dev          # http://localhost:4000, restarts on file changes
bun run check        # read-only check of the MongoDB + Liquifia credentials
bun scripts/make-admin.ts someone@example.com   # promote a registered user to admin
bun run migrate:branches   # one-off: head office for businesses approved before branches (no Liquifia calls)
bun test             # in-memory MongoDB + mock Liquifia; tests/setup.ts overrides the live keys
```

Environment variables go in `backend/.env`; see `backend/.env.example`. Bun loads `.env` automatically.

| Var | Notes |
| --- | --- |
| `MONGODB_URI`, `MONGODB_DB_NAME` (default `linkpay_business`), `MONGODB_USERNAME`, `MONGODB_PASSWORD` | Username and password are passed to the driver separately from the URI. |
| `LIQUIFIA_SECRET_KEY` (required), `LIQUIFIA_PUBLIC_KEY`, `LIQUIFIA_BASE_URL` | ⚠️ The current `.env` has **live** keys (`sk_live_`), so creating anything on Liquifia uses real money. Ask Liquifia for `sk_test_` keys for development. |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `ENCRYPTION_KEY` | Generate secrets with `openssl rand -hex 32`. `ENCRYPTION_KEY` encrypts BVNs. |
| `UPLOAD_DIR` | Local folder for verification documents (gitignored). |
| `WEB_URL` | Public web URL used in emailed links (team invites). Default `http://localhost:3000`. |
| `LIQUIFIA_WEBHOOK_SECRET` | Verifies Liquifia webhooks. Until it's set, `POST /api/webhooks/liquifia` returns 503 and incoming payments arrive through the periodic sync only. |
| `LIQUIFIA_SYNC_INTERVAL_MS` | How often the server pulls incoming payments from Liquifia (default 60000; 0 turns it off). |

Until a real email provider is connected, **emails, including OTP codes, are printed to the backend console.**

### Web
```bash
cd web
bun install
bun dev              # http://localhost:3000
```
### Mobile
```bash
cd backend && bun run dev:mock    # API on :4000 with in-memory MongoDB + mock Liquifia (never reads backend/.env)
cd backend && bun run dev:mock --seed   # same, plus a verified demo business (scripts/dev-seed.ts): demo@linkpay.test / password123
cd mobile && bunx expo run:ios     # development build on the simulator; or run:android
```
`mobile/.env.example` lists the `EXPO_PUBLIC_*` settings. Screenshots are blocked in the app unless `EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE=1` (development only).

### Web
`web/.env.local` sets `API_URL` (default `http://localhost:4000`) and `NEXT_PUBLIC_SUPPORT_EMAIL`. The auth token lives in an httpOnly cookie (`src/lib/session.ts`). The browser never calls the backend directly; all calls go through server actions and route handlers (`src/lib/api/client.ts`).

---

## 3. Status

### Backend

| Area | Status | Where |
| --- | --- | --- |
| Express app, MongoDB, error handling | ✅ | `src/app.ts`, `src/config/`, `src/middleware/errorHandler.ts` |
| Auth: register, email verification, password sign-in, passwordless email-code sign-in | ✅ | `src/controllers/auth.ts` |
| 2FA: authenticator app (TOTP) or email code; challenge-token login step | ✅ | `src/services/totp.ts`, `src/services/otp.ts` |
| Rate limiting on auth routes (30 per 15 min per IP; off when `NODE_ENV=test`) | ✅ | `src/routes/auth.ts` |
| Device sessions (mobile): sign-ins that send `device` get a 15-minute access token tied to a `Session` plus a rotating refresh token (hash stored; reuse of an old token revokes the session; one 30-second grace retry for a dropped response; 30-day idle, 90-day absolute expiry). Refresh, logout, list, revoke one, revoke others. `requireAuth` rejects tokens of revoked sessions (`SESSION_REVOKED`). Web sign-ins (no `device`) are unchanged | ✅ | `src/models/Session.ts`, `src/services/sessions.ts`, `src/middleware/auth.ts`, `tests/sessions.test.ts` |
| Biometric sign-in (mobile): sign-ins may send `device.installationId`; a signed-in phone can get a biometric key (`POST /auth/biometric`, secret returned once, hash stored, one live key per user and installation, 60-day idle and 180-day absolute expiry); `POST /auth/biometric/login` opens a new device session for that installation with no 2FA step (the key was made inside a session that passed it, and needs the phone plus its enrolled biometrics). Ended by `DELETE /auth/biometric`, `logout` with `forgetDevice`, signing that device out remotely, "sign out other devices" (also phones already signed out) and refresh-token reuse. A plain logout keeps it | ✅ | `src/models/BiometricKey.ts`, `src/services/biometricKeys.ts`, `tests/biometric.test.ts` |
| Business onboarding: profile, people (BVN encrypted), document upload, checklist, submit | ✅ | `src/controllers/business.ts`, `src/services/kyb.ts`, `src/config/kyb.ts` |
| Admin review: queue, detail, document download, approve / request changes / reject | ✅ | `src/controllers/admin.ts` |
| Approval gate middleware `requireApprovedBusiness` | ✅ | `src/middleware/roles.ts` |
| Liquifia client (auth, timeouts, idempotency keys, error mapping to `502 PROVIDER_ERROR`) | ✅ | `src/services/liquifia/client.ts` |
| Bank account created on approval (Liquifia customer + held NGN virtual account), admin retry | ✅ | `src/services/accounts.ts` |
| `GET /api/accounts` with live balance (in kobo), branch attached, `?branch=` filter | ✅ | `src/controllers/accounts.ts` |
| Branches: head office auto-created on approval (lazily too, for older businesses), `GET/POST/PATCH /api/branches`, own NGN virtual account per branch. The head office uses the business's Liquifia customer (with the principal's BVN); every other branch is its own customer **without a BVN** (Liquifia doesn't require one). Admin retry per branch | ✅ | `src/models/Branch.ts`, `src/controllers/branches.ts`, `src/services/accounts.ts`, `scripts/migrate-branches.ts` |
| Team: memberships with fixed roles (owner, admin, finance, approver, viewer) built on permissions, optional branch scope, email invites (7-day links, resend, revoke, sign up straight from the link), business switching with `X-Business-Id`, `GET /api/business` for members | ✅ | `src/config/permissions.ts`, `src/models/{Membership,Invite}.ts`, `src/services/team.ts`, `src/controllers/{team,invites}.ts`, `src/middleware/roles.ts` |
| Incoming payments: `Transaction` records synced from Liquifia `GET /inbound-transfers` every minute (and at most every 30 s on reads), keyed by Liquifia's id so re-syncs update status and fees without duplicating; transfers on accounts that aren't ours are ignored. `GET /api/transactions` (filters, search, paging, branch scope), `GET /api/transactions/summary`, `GET /api/transactions/:id`; admin `POST /api/admin/transactions/sync` | ✅ | `src/models/Transaction.ts`, `src/services/transactions.ts`, `src/controllers/transactions.ts` |
| Liquifia webhook `POST /api/webhooks/liquifia`: raw-body HMAC check, every event stored once (`WebhookEvent`), credit events trigger an immediate sync | 🟡 Built, **off until the webhook secret arrives**; the signature scheme is assumed (see §5) | `src/controllers/webhooks.ts` |
| Transfers: bank list (cached a day), name enquiry (`/payouts/validate`, flags recipients that are on LinkPay or a branch of the same business), fee quote (flat ₦20 + ₦50 stamp duty from ₦10,000), single, branch-to-branch and bulk (up to 200 rows, every row checked first) transfers, `Idempotency-Key` header, available balance = Liquifia balance − holds (checked under a short per-account lock), approval rule per business (`never`/`always`/`above_threshold`; anyone without `transfers.approve` always needs approval; nobody approves their own), approve/reject/cancel singly or per batch, payout sent with a stored idempotency key and retried until Liquifia accepts it, background follow-up until `success`/`failed`, payout debits recorded as `Transaction`s (`type: "payout"`), emails to approvers and on rejection or failure. `GET /api/accounts` balances add `heldKobo` and `availableKobo` | ✅ (mock only; no live payout sent yet) | `src/models/Transfer.ts`, `src/services/transfers.ts`, `src/controllers/transfers.ts`, `tests/transfers.test.ts` |
| Email provider | 🟡 Console only | `src/services/email.ts`: plug in with `setEmailProvider()` |
| File storage | 🟡 Local disk only | `src/services/storage.ts`: plug in S3/R2 with `setFileStorage()` |
| Automated tests in the repo | 🟡 Branches, admin, team, transactions, sessions, biometric, transfers | `tests/*.test.ts` (88 tests in total) with `tests/helpers.ts` (in-memory MongoDB via `mongodb-memory-server`) and `tests/mockLiquifia.ts`. `tests/setup.ts` is preloaded (`bunfig.toml`) and replaces the live Liquifia key and URL. The earlier auth, KYB and accounts suites still need to be rewritten into `tests/`. |

### Web (`web/`)

| Area | Status |
| --- | --- |
| Landing page | ✅ `src/app/page.tsx`, `src/components/landing/` |
| Auth: sign up, verify email, sign in, 2FA, email-code sign-in | ✅ `src/app/(auth)/` |
| Onboarding wizard: type, details, people, documents, review, status | ✅ `src/app/(onboarding)/onboarding/` |
| Dashboard shell: sidebar, status banner, branch switcher (real branches, "All branches", choice kept in the `lp_branch` cookie) | ✅ `src/components/shell/`, `src/lib/branches.ts` |
| Home and Accounts (account number, balance, setup states), narrowed to the selected branch via `GET /api/accounts?branch=` | ✅ `src/app/(dashboard)/dashboard`, `/accounts` |
| Settings: profile and security (TOTP QR code, email 2FA, disable) | ✅ `src/app/(dashboard)/settings/` |
| Admin (staff console): its own sidebar shell with live counts, review queue with summary tiles, `/admin/businesses` data table (TanStack Table v9 via `src/components/data-table/`, with URL-driven status tabs, search, sort, page size and column visibility), business detail with one panel per section and a sticky document viewer, per-branch account retry | ✅ `src/app/admin/`, `src/components/admin/`, `src/lib/admin.ts` |
| Branches: list with account numbers and setup state (auto-refreshes for about a minute while an account is being set up), add and edit in a dialog, "View this branch" | ✅ `src/app/(dashboard)/branches/`, `src/components/branches/` |
| Team: members, pending invites, invite dialog (roles from `GET /api/team/roles`, branch picker), change role or branches, remove, resend and revoke, leave business, calm state for members without `team.manage` | ✅ `src/app/(dashboard)/team/`, `src/components/team/` |
| Invite links `/invite/[token]` (public): sign up from the link, sign in and accept (through 2FA, email prefilled), wrong-account switch, dead ends for expired, revoked, used and invalid links | ✅ `src/app/invite/`, `src/components/auth/auth-shell.tsx` |
| Business context: `lp_business` cookie sent as `X-Business-Id` (`src/lib/business-context.ts`, `src/lib/api/client.ts`), business switcher in the sidebar when the user has more than one, permission-based hiding (`src/lib/permissions.ts`), onboarding owner-only | ✅ |
| Transactions: `/transactions` with money-in total for the period, filters in the URL (period presets and custom range in Lagos time, status, money in/out, debounced search), the branch switcher as the default branch (`?branch=` from Accounts shows as a removable filter), server paging, detail sheet, stacked rows on phones, "no payments yet" and "no matches" states; Home shows the 5 latest and money in this month; "View transactions" on each account; hidden without `accounts.view` | ✅ `src/app/(dashboard)/transactions/`, `src/components/transactions/`, `src/lib/transactions.ts` |
| Transfers: list, detail sheet, new transfer (bank or own branch), bulk (CSV upload or paste), approval rule dialog, available and held balances on Accounts | ✅ (mock only) `src/app/(dashboard)/transfers/`, `src/components/transfers/`, `src/lib/transfers.ts`. Checked in a browser against `dev:mock --seed` (2026-10-20): single bank transfer through review to "Sent", list, detail sheet, bulk row checks, approval rule dialog, desktop and 375px. Approve/reject by a second member not yet clicked through in the browser |
| Invoices | ⏳ Placeholder page |

### Mobile (`mobile/`)

Built in four slices with a check-in after each (product owner's decision, 2026-10-20): (1) setup, design system, auth and app lock; (2) Home (branch deck), accounts, transactions; (3) onboarding (KYB) with the camera; (4) branches, team, invites, settings. The admin console stays web-only. Home is the **Branch deck** (chosen on the design decision page; contract in `.impeccable/surfaces/mobile.md`).

| Area | Status |
| --- | --- |
| Expo SDK 58 development build (expo-dev-client), Expo Router with `Stack.Protected` gates, NativeTabs, NativeWind tokens converted from the web, embedded Bricolage cut at the web's width 92, brand icon and splash | ✅ slice 1 |
| Auth: welcome, sign in, sign up, verify email, email-code sign-in, 2FA (TOTP and email), resend cooldowns, session-ended notices | ✅ slice 1 |
| Security: device sessions with rotating refresh token in the keychain (device-only), access token in memory, 4-digit app passcode (PBKDF2 at 1,000 rounds, simple codes refused, 5 wrong tries sign the phone out), Face ID / fingerprint unlock with app-passcode fallback only, lock after 60 s in background or 5 min idle, privacy cover and app-switcher blur, screenshots and recording blocked, Android backup off | ✅ slice 1 |
| Biometric sign-in: one switch offer at setup turns on unlock and sign-in with a single confirmation (one biometric-bound keychain item holds both, since Android prompts on every read and write); separate switches under More; signed-out phones with it on show "Welcome back, name" with Face ID first, "Use password instead" and "Not you?"; a plain sign-out or an expired session keeps the passcode and Face ID, so signing back in goes straight in; "Sign out and forget", forgot passcode, too many wrong passcodes, a remote sign-out or a newly enrolled face or finger forget the phone; devices list shows which phones have it | ✅ (typechecked and linted; not yet run on a device) |
| More: biometric toggle, appearance (System, Light, Dark; saved on the phone, kept after sign-out), change passcode, signed-in devices (sign out one or all others), lock now, sign out | ✅ slice 1 |
| Home branch deck: band with business and greeting (switcher when the user has several businesses), snap deck of branch cards (balance, account number, Share, setup and unavailable states, one haptic tick per snap, page dots), "Money in today" for the card in view with a shared-axis slide, refreshing every 30 s; gate states for no business, verification in review / changes / rejected, and roles without `accounts.view` | ✅ slice 2 (seen on the simulator with real data; flows not yet tapped through) |
| Account details (copy number, name, bank; share; view payments), Payments tab (period pills, branch and status filter list, search, money-in summary, day sections, infinite paging, empty and no-match states), payment detail (status note, payer, reference copy, fee and net) | ✅ slice 2 (typechecked and linted; not yet run) |
| Onboarding (KYB) | ⏳ slice 3 |
| Transfers (single, on `/api/transfers`): Send money from each Home card and the Payments and Transfers headers (`transfers.create`); form with source account and available balance, bank or another branch, bank picker with search, name enquiry as the 10 digits land (shows "On LinkPay" for platform accounts), amount and narration; review with the partner's fee, stamp duty and total, approval warning, then Face ID or the app passcode (`ConfirmPasscode`, same 5-try limit) and an Idempotency-Key kept per review. Transfers list (tabs as on the web, "Needs your approval" with its count for approvers, approval rule line, Change for `transfers.manage`), approval rule screen (the web's three options), transfer detail (status, banners, decision note, approve with Face ID or passcode, reject, cancel own, check status, polls every 10 s while in progress), "View transfer" on payout payments, Home banner when transfers wait for the member's approval. Bulk transfers stay web-only for now | ✅ (typechecked and linted; not yet run) |
| Team tab: members (role tag, branches), pending invites (resend with the cooldown from `retryAt`, revoke), invite form (role cards from `GET /api/team/roles` with the web's descriptions, branch access, admin only for the owner), member screen (change role and branches, remove), leave business; members without `team.manage` see their own access and Leave, as on the web | ✅ slice 4 (typechecked and linted; not yet run) |
| Branches under More: cards with account number, address and manager, refreshing every 5 s while an account opens; add and edit (head office keeps its name; state field offers the web's list; `BRANCH_NAME_TAKEN` under the name) for `branches.manage` | ✅ slice 4 (not yet run) |
| Invite links: `linkpaybusiness://invite/<token>` opens `src/app/invite/[token].tsx` signed in or out: join with the invited account, create an account from the link (device session, then passcode), or sign in first and the invite reopens once unlocked; dead ends for used, cancelled, expired and invalid links. Email links still point at the web (`WEB_URL/invite/...`); opening them in the app needs universal links / app links on the real domain | ✅ slice 4 (not yet run) |
| More: Business (verified details, locked; changes via support), Branches, Switch business, Profile (name, email, member since), Two-step verification (authenticator app set up on the phone itself: opens the authenticator with the otpauth link or shows the key; email codes and turning off confirm the password). Home's greeting and business row is now a fixed header; the title, deck and list scroll beneath it | ✅ slice 4 (More seen on the simulator; screens not yet run) |

Tooling is ready: the official Expo Claude Code plugin (`expo@claude-plugins-official`) is enabled at project scope in `.claude/settings.json`. It provides 24 Expo/EAS skills and the remote Expo MCP server (`https://mcp.expo.dev/mcp`, OAuth; run `/mcp` once to sign in with an Expo account). Once the app exists (SDK 54+), add local MCP capabilities from `mobile/`: `npx expo install expo-mcp --dev`, then `EXPO_UNSTABLE_MCP_SERVER=1 npx expo start`.

---

## 4. Backend API (summary)

All routes are under `/api`. Errors look like `{ error, code?, details? }`. Money is always an **integer in kobo**.

| Group | Endpoints |
| --- | --- |
| Auth `/auth` | `POST register`, `verify-email`, `verify-email/resend`, `login`, `login/2fa`, `login/2fa/resend`, `otp/request`, `otp/verify` · `GET me` · `POST 2fa/totp/setup`, `2fa/totp/enable`, `2fa/email/enable`, `2fa/disable` · Device sessions: `verify-email`, `login`, `login/2fa`, `otp/verify` and `POST /invites/:token/register` accept `device: { name, platform: ios\|android\|web\|other, model?, osVersion?, appVersion? }` and then return `{ accessToken, refreshToken, sessionId, user }` · `POST refresh` `{ refreshToken }` (rotates; 300 per 15 min per IP) · `POST logout` `{ refreshToken }` (204) · `GET sessions` · `DELETE sessions/:id` · `POST sessions/revoke-others`. Codes: `INVALID_REFRESH_TOKEN`, `SESSION_REVOKED`, `SESSION_NOT_FOUND` |
| Business `/business` | `POST /`, `GET /`, `PATCH /` · `POST/PATCH/DELETE people[/:personId]` · `POST documents` (multipart), `GET documents/:id/file`, `DELETE documents/:id` · `POST submit` |
| Branches `/branches` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id` (approved businesses only). Each branch has `{ name, isHeadOffice, address, manager: { name, email, phone }, liquifia: { accountStatus }, account: { id, accountNumber, accountName, bankName, currency } \| null }`. Names are unique per business, ignoring case (`409 BRANCH_NAME_TAKEN`); "Head office" is taken by the head office. |
| Accounts `/accounts` | `GET /?branch=<id>` (approved businesses only). Each account includes `branch: { _id, name, isHeadOffice }`. |
| Admin `/admin` | `GET summary` (counts per status, failed account setups) · `GET businesses?status=&account=&q=&sort=submitted\|created\|name&dir=&skip=&take=`, `GET businesses/:id`, `GET businesses/:id/documents/:documentId/file`, `POST businesses/:id/approve`, `/request-changes`, `/reject`, `/provision-account` (head office), `/branches/:branchId/provision-account` |
| Team `/team` | Approved business; `team.manage` for everything except `GET roles` and `POST leave`. `GET roles` · `GET members`, `PATCH members/:id` `{ role?, branches? }`, `DELETE members/:id` · `GET invites` (pending), `POST invites` `{ email, role, branches? }`, `POST invites/:id/resend`, `DELETE invites/:id` · `POST leave` |
| Invites `/invites` | Public links. `GET /:token` (preview: business, role, inviter, `status: pending\|accepted\|revoked\|expired`, `accountExists`) · `POST /:token/accept` (signed in with the invited email) · `POST /:token/register` `{ name, password }` (new user; created verified and signed in, returns `accessToken`) |
| Memberships `/memberships` | `GET /`: every business the user belongs to (`role`, `roleLabel`, `isOwner`), for the business switcher |
| Transactions `/transactions` | Approved business, `accounts.view`, limited to the member's branches. `GET /?branch=&direction=credit\|debit&status=pending\|success\|failed\|reversed&from=&to=&q=&skip=&take=` returns `{ items, total, skip, take }`, newest first; each item is `{ _id, type: "inbound_transfer", direction, amountKobo, feeKobo, netKobo, currency, status, counterparty: { name, bankName, accountNumber }, narration, reference, occurredAt, branch: { _id, name, isHeadOffice }, account: { _id, label, accountNumber, bankName } }` · `GET /summary` (same filters minus status and direction; successful only) returns `{ inflowKobo, outflowKobo, feesKobo, count, currency }` · `GET /:id` |
| Transfers `/transfers` | Approved business. `GET banks`, `POST resolve-account` `{ accountNumber, bankUuid }`, `GET fee?amountKobo=` (`transfers.create`) · `GET settings` (`accounts.view`), `PATCH settings` `{ approval: { mode, thresholdKobo? } }` (`transfers.manage`) · `GET /?status=&kind=&branch=&batch=&awaiting=me&from=&to=&q=&skip=&take=`, `GET /:id`, `POST /:id/refresh` · `POST /` `{ branch, amountKobo, narration?, recipient: { type: "bank", accountNumber, bankUuid } \| { type: "branch", branch } }` with optional `Idempotency-Key` header · `POST bulk` `{ branch, title?, items[] }` · `POST /:id/approve\|reject` `{ note? }` (`transfers.approve`), `POST /:id/cancel` (creator) · `GET batches/:id`, `POST batches/:id/approve\|reject\|cancel`. Statuses: `pending_approval → processing → success \| failed`, or `rejected` / `cancelled`. Codes: `INSUFFICIENT_BALANCE` (`details.availableKobo`, `requiredKobo`), `NO_APPROVER`, `CANNOT_APPROVE_OWN`, `TRANSFER_NOT_PENDING`, `SAME_ACCOUNT`, `ACCOUNT_NOT_FOUND`, `INVALID_BANK`, `INVALID_ROWS` (`details.rows`), `ACCOUNT_BUSY`, `ACCOUNT_NOT_READY`, `RECIPIENT_BANK_UNKNOWN` |
| Webhooks `/webhooks` | `POST /liquifia` (Liquifia only; raw body, `X-Liquifia-Signature`). `payout.success`/`payout.failed` trigger a follow-up of open transfers |
| Users `/users` | `GET /` and `GET /:id` (platform admins only) · `PATCH /:id` and `DELETE /:id` (own account only) |

The business statuses are `draft → submitted → approved | rejected`, with `changes_requested` sending a business back for edits. The account setup status is `branch.liquifia.accountStatus`: `not_started | pending | active | failed`. `business.liquifia.accountStatus` mirrors the **head office** branch and is still what the web's home and accounts pages read. Owners see only the status; admins also see `customerId` and `lastError`. `GET /api/business` and the admin business detail now also return `branches`.

**Team.** Every request to a business-scoped route may send `X-Business-Id`; without it the backend uses the business the user owns, otherwise the one they joined first. `GET /api/business` works for any member and returns `membership: { _id, role, permissions[], branches: string[] | null }` (`null` = every branch). Members below admin get `documents: []`, `business.people: []` and `checklist.items: []`; members limited to branches only get those branches and their accounts. Permissions: `accounts.view`, `branches.manage`, `team.manage`, and (for features to come) `transfers.create`, `transfers.approve`, `invoices.manage`. Only the owner can add, change or remove admins; nobody can change the owner or their own access. Error codes: `PERMISSION_DENIED`, `NOT_A_MEMBER`, `INVALID_BUSINESS_ID`, `ALREADY_MEMBER`, `INVITE_EXISTS`, `INVITE_COOLDOWN`, `INVITE_CLOSED`, `INVITE_EXPIRED`, `INVITE_NOT_FOUND`, `INVITE_EMAIL_MISMATCH`, `EMAIL_TAKEN`, `OWNER_ONLY`, `CANNOT_MODIFY_OWNER`, `CANNOT_MODIFY_SELF`, `OWNER_CANNOT_LEAVE`, `INVALID_BRANCH`.

---

## 5. Liquifia integration notes

- The client is `backend/src/services/liquifia/client.ts`. Endpoints are under `/api/v1`, with Bearer auth using the secret key.
- **Where the live API differs from the docs:**
  - `GET /integrator` returns 404. Use `GET /me`.
  - `GET /wallet` returned an empty list, not the balance object described.
  - `/me` does **not** include the webhook secret.
- **Money units differ by endpoint:** payouts use naira (major units); services and the virtual account balance (`GET /virtual-accounts/:id/balance`, confirmed by the product owner, even though the docs say naira) use kobo; webhooks use cents. Convert only inside the Liquifia client code. Internally everything is kobo.
- Customers are person-shaped (first and last name). Business names are split, so "Acme Trading Ltd" becomes "Acme" + "Trading Ltd", and a one-word name gets "Business" as its last name (`src/services/accounts.ts`). **Confirm with Liquifia whether a business customer type exists.**
- **A BVN isn't required** (confirmed by the product owner, 2026-10-20). The first principal's BVN (a director, owner, partner or trustee) is sent only with the business's own customer (the head office); branch customers are created without one, so a BVN is never sent on several customers.
- **Payouts:** requests and fee quotes are in naira (`toNaira()`/`toKobo()` in the client). The fee quote (`GET /payouts/fee?amount=`) was checked read-only on the live API: a flat ₦20 plus ₦50 stamp duty from ₦10,000, and `fee` already includes the stamp duty. Payout statuses are `pending`, `processing`, `success`, `failed`. Money amounts in payout *responses* are never read (the docs disagree on their unit). No live payout has been sent yet; the first one will confirm the response shape (`provider.data` keeps it).
- The virtual account's response fields (`id`, `account_number`, `account_name`, `bank_name`) were taken from the docs and are not yet confirmed against a live response. The raw response is saved in `VirtualAccount.providerData` for checking.
- Creates need `X-Idempotency-Key`. Provisioning stores the key on the **branch** and reuses it on retries. Head offices of businesses approved before branches existed inherit the old key from `business.liquifia`.
- **One NGN virtual account per customer (seen on the live API; not in the docs).** Asking for a second account, even with a new idempotency key, returns the customer's existing one. So:
  - The head office uses the business's customer (`biz<businessId>`).
  - Every other branch is **its own customer** (`biz<businessId>br<branchId>`), named "<business name> <branch name>". That name is the account name payers see, and it has the same principal's BVN. The ID is stored on `branch.liquifia.customerId`.
  - Renaming a branch doesn't rename its customer or account name on Liquifia.
  - `provisionBranchAccount` refuses to link an account that already belongs to another branch.
  - The mock (`tests/mockLiquifia.ts`) behaves the same way.
- Liquifia's webhooks can arrive out of order. Always check the `status` field, and ignore duplicate events.
- **Inbound transfers** (`GET /inbound-transfers?skip=&take=`, a plain array): `amount` and `fee` are **strings in kobo** (a ₦100.00 payment is `"10000"`; the bank's own `raw_payload.amount` says `"100.00"`). Payer details are `payer_name`, `payer_bank_name`, `payer_bank_account`; the status is `latest_status`. The sort order isn't documented, so each sync reads every page (capped at 5,000 transfers); add an incremental cursor once volume grows. Checked against the one live transfer on 2026-09-26 without writing anything: it maps to our account and parses.
- **Webhook signature (assumed):** hex HMAC-SHA256 of the raw body with the webhook secret, optionally prefixed `sha256=`, in `X-Liquifia-Signature`. Confirm with Liquifia and adjust `verifyLiquifiaSignature()` in `src/controllers/webhooks.ts` if it differs. Webhooks only *trigger* a sync; the recorded data always comes from `GET /inbound-transfers`, so their payload format doesn't matter.

---

## 6. Next up (in order)

1. **Transfers:** backend done and tested on the mock; web built. Left: click through approve/reject with a second member in the browser, the product owner's sign-off, then a first small **live** payout (needs the product owner's go-ahead) to confirm the payout response. Mobile Transfers after that.
2. **Invoices** ← next once Transfers is signed off: create, send, PDF, reminders, auto-generated receipts.
3. **Scheduled transfers (Auto-Send), savings profiles** (via the bank partner), transaction statements and exports.
4. **Mobile app:** slices 1, 2 and 4 built, plus biometric sign-in and single Transfers (2026-10-20). Waiting for the product owner to run them (`dev:mock --seed`) and sign off. Left: slice 3 (onboarding / KYB with the camera), bulk transfers, Invoices once the backend has them, universal links for invite emails, then the design finish review and a mobile DESIGN.md.
5. **Team follow-ups** (product decisions): custom roles, transferring ownership, linking a branch's `manager` contact to a member, and a "Start your own business" entry for users who are only members elsewhere.

Branches, still to do:
- Before deploying, run `bun run migrate:branches` once (the API also creates head offices lazily, so this is a safety net).
- Not built: archiving or closing a branch (a branch with an account shouldn't be deleted), a limit on branch count, and clearing an optional branch field (PATCH merges, and the API rejects empty strings, so a saved street or manager can be changed but not removed).
- The branch manager is contact details only until Team exists.

Technical debt to fit in along the way:
- Rewrite the earlier auth, KYB and accounts e2e suites into `backend/tests/`. The harness (`tests/helpers.ts`, `tests/mockLiquifia.ts`) is in place.
- Connect a real email provider and S3/R2 storage.
- Refresh tokens and session revocation for the **web** (mobile has device sessions; the web still uses a 7-day token that can't be revoked).
- Password reset.
- Recovery codes for authenticator-app 2FA.
- Encrypt TOTP secrets at rest.
- Automatic BVN/NIN checks through Liquifia `/kyc/bvn`.
- Audit logs.
- `scripts/make-admin.ts --revoke`.

## 7. Open questions and blockers

| # | Question | Owner |
| --- | --- | --- |
| 1 | Webhook secret for `X-Liquifia-Signature`, **and the signature scheme** (we assume hex HMAC-SHA256 of the raw body) | Ask Liquifia |
| 2 | Test keys (`sk_test_`) for development | Ask Liquifia |
| 3 | Does Liquifia support business customers (the account name shown to payers)? | Ask Liquifia |
| 4 | Are the verification documents per business type (`backend/src/config/kyb.ts`) correct? | Bank partner's compliance team |
| 5 | Which email provider (Resend, SES, …)? | Product owner |
| 7 | Mobile bundle id / package `com.linkpay.business` and the support email `support@linkpay.ng` are placeholders. Real values? | Product owner |
| 10 | Invite emails link to the web. Should the app open them (universal links / Android app links on the production domain, needing the real domain and bundle id from #7)? | Product owner |
| 9 | Biometric sign-in skips 2FA (device key plus enrolled biometrics count as two factors) and lasts up to 180 days without a password. Acceptable for the bank partner? | Product owner / compliance |
| 8 | Mobile blocks screenshots app-wide (Android FLAG_SECURE, iOS capture blocking). Keep, or allow them on screens like account details? | Product owner |
| 6 | ~~Can one customer hold several NGN accounts?~~ **No** (2026-09-26). ~~Same BVN on several customers?~~ Not needed: Liquifia doesn't require a BVN, so branch customers are created without one (2026-10-20; Island Outlet opened live that way). | Closed |

---

## 8. Session log

Add a line per session: date, what was done, and anything left half-finished.

- **2026-09-25:**
  - Backend: Express, MongoDB, auth, 2FA and email codes, controllers and routes split, business onboarding (KYB) with admin review, Liquifia client, accounts provisioned on approval, `GET /api/accounts`.
  - Web (a separate session): landing, auth, onboarding, dashboard shell, accounts, settings/security, admin.
  - Nothing is left half-finished. Next: **Branches**.
- **2026-09-25 (later):** Branches backend.
  - `Branch` model, `VirtualAccount.branch`, provisioning moved per branch (`provisionBranchAccount`), and `ensureHeadOffice` (runs on approval and lazily; `scripts/migrate-branches.ts`).
  - `GET/POST/PATCH /api/branches`, `?branch=` on accounts, admin per-branch retry, and branches in the business overview.
  - The first saved test suite: `tests/branches.test.ts`, 10 passing, run only against mocks with no Liquifia calls.
  - Nothing is left half-finished. Next: **Branches web**.
- **2026-09-26:** Creating a branch on the live API failed with E11000 on `providerAccountId`. Liquifia had returned the head office's account again, because it gives one NGN account per customer.
  - Fixed: every non-head-office branch now gets its own Liquifia customer, with a fresh idempotency key when that customer is created, plus a guard against linking one account to two branches. The mock was updated to match; 36 tests pass.
  - ⚠️ Half-finished *(fixed 2026-10-20, see below)*: branch `6ab6fd7cbb94f00c4ae079a0` (live) is still `failed`. Retrying it (`POST /api/admin/businesses/:id/branches/6ab6fd7cbb94f00c4ae079a0/provision-account`) will create a **real** Liquifia customer and account. This needs the product owner's go-ahead, and it will also answer whether a BVN can be reused across customers.
- **2026-09-25 (evening):** Web.
  - Landing page redesigned (`src/components/landing/`, uses `motion` and `lenis`); `/` is the public landing page and the dashboard home moved to `/dashboard`.
  - Branches web: the switcher uses real branches and remembers the choice in the `lp_branch` cookie (stale ids fall back to All branches); Home and Accounts filter `GET /api/accounts?branch=`; Branches page with add and edit; admin branches panel with per-branch retry.
  - Tested in a browser against a throwaway mock API (not the real backend, to avoid creating Liquifia accounts with the live keys): switching, duplicate-name error, validation, create, auto-refresh when the account opens, edit, admin retry. Not yet tried against the real backend.
  - Left for whoever works on admin: `src/components/admin/businesses-table.tsx` (from a parallel session) currently fails two `react-hooks` lint rules. *(Fixed since in the admin redesign session; `bun run lint` passes.)*
- **2026-09-25 (admin redesign):**
  - Backend: search (`q`: business name, RC/BN, email, owner name or email), `sort`/`dir` and `account` filter on `GET /admin/businesses`; new `GET /admin/summary`. Tests: `tests/admin.test.ts` (8 passing).
  - Web: the staff console now has its own shell (`AdminSidebar`: Review queue, With owners, All businesses, Account setup failed, with counts; a "Your business" link for admins who own one) and a skip link. `/admin/businesses` is new. Reusable data table in `src/components/data-table/`. The business detail page was restructured into `AdminSection` panels. The document list no longer misuses `role="listbox"`.
  - Fixed `timeAgo` (`lib/format.ts`), which labelled values with the wrong unit ("6 hours ago" for 6 days).
  - Still failing and not from this work: `tests/branches.test.ts:221` (balance kobo/naira mismatch between `accounts.ts` and the mock).
- **2026-09-25 (balance units):** the product owner confirmed that Liquifia's virtual account balance is in **kobo**. The test mock and `branches.test.ts` were switched to kobo, and `bun test` passes (18/18).
- **2026-09-25 (team backend):**
  - Memberships and roles on permissions (`src/config/permissions.ts`), branch scope, email invites with sign-up from the link, `X-Business-Id` business switching, `GET /api/memberships`. `requireApprovedBusiness` now works through membership, and `requirePermission` guards actions (`branches.manage` on creating and editing branches, `accounts.view` on accounts).
  - Owner memberships are created lazily, so no migration is needed. New env var `WEB_URL` for invite links.
  - Security fix: `GET /api/users` and `GET /api/users/:id` were open to any signed-in user; now platform admins only.
  - `tests/team.test.ts` (16 tests); the suite passes 34/34. The test helper's `api()` accepts `headers`.
  - Nothing is left half-finished. Next: **Team web**.
- **2026-09-26 (team web):**
  - Business context: `lp_business` httpOnly cookie sent as `X-Business-Id` from `api()` and `apiFile()`. On `NOT_A_MEMBER`/`INVALID_BUSINESS_ID` the cookie is cleared and **reads** retry without it; **writes do not retry** (repeating a POST without the header would act on the user's other business). A Server Component can't clear cookies, so the dashboard layout mounts `ClearStaleBusiness` when the cookie doesn't match. Switching business and sign-out clear `lp_branch` too.
  - Team page, invite dialog, access dialogs, pending invites (resend with the 60-second cooldown, revoke), leave business; `/invite/[token]` for every state; business switcher; permission hiding (Branches add/edit, "View branches" in the switcher, Accounts and Home by `accounts.view`, owners-and-directors list and the welcome banner only with `team.manage`); onboarding redirects non-owners to `/dashboard`; Home picks a branch-limited member's first branch when there's no head office.
  - Tested in a browser against the real backend code on an isolated stack (local MongoDB `linkpay_team_test`, Liquifia mock; the live keys were never used): owner invites Finance, Viewer (one branch) and Admin; sign-up from the link; existing user signs in (prefilled email) and accepts; wrong account signed in; admin can't touch the owner, themselves or admins and isn't offered Admin; role and branch changes show on the member's dashboard; revoke, expiry, invalid link; removal (to onboarding, or to the other business with the cookie cleared); switching between two businesses; leaving. Light, dark and 375px checked. `tsc` and lint pass.
  - Team API gaps (backend not changed):
    1. `GET /api/memberships` has role names but no labels; the switcher capitalises the name. Adding `roleLabel` would keep custom roles readable.
    2. `INVITE_COOLDOWN` doesn't say when resending is allowed again (no `Retry-After` or `retryAt`); the web assumes 60 seconds.
    3. The invite preview doesn't include the invite's branches, so the invite page can't say "for Ikeja store".
    4. For a branch-limited member, `GET /api/business` still returns `business.liquifia.accountStatus` (the head office's status). The web now uses the member's own branch instead.
    5. A user whose only memberships are in other businesses can't start their own business from the web: `GET /api/business` returns the member business, so onboarding redirects them to the dashboard. The backend allows `POST /api/business`; an entry point (for example "Start your own business" in the switcher) is a product decision.
    6. The auth rate limiter (30 per 15 minutes per IP) returns plain text; the web maps any 429 to generic copy. Already known.
  - Nothing is left half-finished.
- **2026-09-26 (incoming payments backend):**
  - Team API gaps 1–4 fixed: `roleLabel` on memberships; `INVITE_COOLDOWN` returns `details.retryAt` and a `Retry-After` header (`HttpError` now takes `details`); the invite preview lists its `branches`; a branch-limited member's `business.liquifia.accountStatus` is their first branch's. Gap 5 (starting your own business) and 6 (plain-text rate-limit 429s) are unchanged.
  - Incoming payments without waiting for the webhook secret: `Transaction` model, sync from `GET /inbound-transfers` (background every minute, on reads at most every 30 s), transactions list/summary/detail, admin manual sync. The webhook endpoint is built but returns 503 until `LIQUIFIA_WEBHOOK_SECRET` is set.
  - Confirmed on live data (read-only): inbound transfer amounts are kobo strings.
  - Deferred: a double-entry ledger (Liquifia's balance stays the source of truth; holds for approvals come with Transfers), payment notification emails, statements and exports.
  - Tests: `tests/transactions.test.ts` (10) plus 4 new Team tests; 50/50 pass. The mock Liquifia serves `/inbound-transfers` (`inboundTransfer()` helper).
  - Nothing is left half-finished. Next: **Transactions web**.
- **2026-09-26 (transactions web):**
  - `/transactions`, Home's recent transactions and money in this month, "View transactions" links on Accounts, Transactions in the nav (Accounts and Transactions nav items are hidden without `accounts.view`). All dates now format in Africa/Lagos time (`lib/format.ts`), which also keeps server and browser renders identical.
  - The admin table's search box moved to `components/data-table/search-box.tsx` and is shared.
  - Picked up the backend's Team fixes: role labels in the business switcher, the invite resend cooldown uses `details.retryAt` (`ActionResult.retryAt`), and the invite page names the invite's branches. These were typechecked and linted, not re-run in a browser.
  - Tested in a browser against the real backend code on an isolated stack (local MongoDB `linkpay_tx_test`; the scratch Liquifia mock now serves `/inbound-transfers` from a file, so the real sync path ran; live keys never used): Home recent list and sheet; this month, all time, last month and a custom range; paging (32 of 32; a transfer to a foreign account was ignored); status, money in/out, search, clear filters; branch switcher and the Accounts link with its removable branch filter; a Viewer limited to Ikeja sees only Ikeja's 11; a business with no payments gets "No payments yet" with Share. Light, dark and 375px checked. `tsc` and lint pass.
  - Transactions API gaps (backend not changed):
    1. No `lastSyncedAt` (or "sync failed") in the list response. Sync errors are swallowed, so the page can't say "Updated 2 minutes ago" or warn that data may be stale.
    2. No way to ask "has this business ever had a transaction?" When the chosen period is empty, the web makes a second call (`take=1`, no dates) to choose between "No payments yet" and "No matches". A `totalAllTime` field, or the summary without dates, would do.
    3. The list is newest-first only (no sort by amount). Fine for now.
  - Nothing is left half-finished.
- **2026-09-26 (transactions loading):** filter, search, period and page changes on `/transactions` now show skeletons shaped like the page (`src/components/transactions/skeletons.tsx`, shared with `loading.tsx`). A router transition never shows `loading.tsx`, so the view drives this from its own pending state. The filter controls update immediately (`useOptimistic`), and screen readers hear "Loading transactions". A manual refresh keeps the current rows on screen. Checked in a browser with slowed requests (light, dark, 375px) and the full Transactions flow rerun.
- **2026-10-20 (Expo tooling):** installed the Expo Claude Code plugin at project scope (v1.13.9; skills plus the Expo MCP server). The MCP server is not authenticated yet (run `/mcp`). `expo-mcp` local capabilities wait until `mobile/` is scaffolded. No app code changed.
- **2026-10-20 (mobile slice 1 + device sessions):**
  - Backend: device sessions for mobile (`Session` model, `src/services/sessions.ts`; refresh rotation with reuse detection and a 30-second grace retry; logout, list, revoke one, revoke others; `requireAuth` rejects revoked sessions). Sign-ins without `device` (the web) are unchanged. `tests/sessions.test.ts` (12); the suite passes 62/62 and typechecks. New `bun run dev:mock` (in-memory MongoDB + mock Liquifia) for running the apps locally without the live `.env`.
  - Mobile: Expo SDK 58 app in `mobile/` (bun). Design context: `PRODUCT.md` (new, platform adaptive), direction contract in `.impeccable/surfaces/mobile.md` (Home = Branch deck, picked by the product owner on the decision page). Bricolage cut at width 92 from the variable font (OFL), brand icon and splash rendered from the logo mark, welcome photo reused from the web landing.
  - Slice 1 built: welcome, sign in, sign up, verify email, email-code sign-in, 2FA; passcode setup and biometric offer; lock screen, auto-lock, privacy cover, capture blocking; More (biometrics toggle, change passcode, signed-in devices, lock now, sign out). Home is a holding screen.
  - Reviewed by two agents (neither could see the Expo MCP; they used the SDK 58 docs): `expo-doctor` 20/20, lint and `tsc` clean. Fixed from the audit: biometric unlock now reads a keychain secret bound to the enrolled biometrics (a newly added face or finger can't unlock), Android needs strong biometrics, reinstall wipes stale iOS keychain items, boot failures fall back to signed out, focus-aware status bars, Reanimated `get`/`set` for React Compiler, TalkBack hidden behind the lock.
  - Built and run on the iPhone 17 Pro simulator; screenshots in `.impeccable/review/`. After the product owner's feedback: the auth screens are now one navy field in both appearances (no white sheet), the type scale is one step smaller, a launch hand-off continues the native splash, and auth draws its own back control (iOS 26's glass back button turned pale on navy in light mode).
  - Not yet exercised on a device: the signed-in half (passcode, lock, Face ID, devices) needs typing on the phone; run `dev:mock`, sign up, and read the code from its console. Android not built yet.
  - Still owed by the design process: the finish review and a mobile DESIGN.md, after slice 2 builds the Home first viewport the contract describes.

- **2026-10-20 (LinkPay logo):** the "L" placeholder is replaced by the real LinkPay bridge mark, traced to a vector from `link_pay/public/images/logo.png` (within 0.3px of the original).
  - One generator renders every asset from that vector: `cd web && bun scripts/brand-assets.ts` (uses `sharp` from `web/node_modules`). Its `MARK_PATH` is duplicated in `web/src/components/brand/logo.tsx`; keep them in sync.
  - Web: the lockup follows the LinkPay site (`link_pay/src/components/layouts/logo.tsx`): the bare bridge in `primary` (navy, lime in dark mode) at 0.78em next to "linkPay" (lowercase l, as there) and a muted "Business". Font size drives the lockup (`text-sm` in the dashboard sidebar). Favicons in `web/src/app/`: `favicon.ico` and `icon.svg` are the bare bridge (the SVG turns lime on dark browser chrome); `apple-icon.png` is the lime app tile.
  - Mobile: the lime tile keeps its shape with the ink bridge inside (`LogoTile` tints `assets/images/logo-mark.png` with `pop-foreground`). App icon, splash, Android adaptive icon and favicon regenerated; `ios/` was regenerated with `expo prebuild` and pods reinstalled. The product owner approved the mobile look as is.
- **2026-10-20 (mobile slice 1 follow-ups):**
  - Auth: one nav row (custom back circle leading, `LogoTile` centred, equal trailing spacer). Back always shows and falls back to the welcome screen when there is no history. `Button` now draws its icon in its own text colour (fixes a dark icon on the navy sign-in button). Welcome photo is now the founder at her desk (`assets/images/welcome.jpg`).
  - Splash: `src/components/brand/launch-overlay.tsx` rewritten as an animated hand-off (~1.8 s: native splash match, lockup with the wordmark, lime moves into the bridge, zoom through the arch to the welcome screen; crossfade with Reduce Motion). Adds `react-native-svg` 15.16.0, so the dev build must be rebuilt (`bunx expo run:ios` / `run:android`); without it the app shows "RNSVGPath is not registered". Not yet checked on a device.
  - Known: parallel `expo run:ios` runs (from agent sessions) lock Xcode's build database and block the product owner's own builds. Agents should not start native builds; the product owner runs them.
  - Slice 1 still waits for the product owner's sign-off before slice 2 starts.
- **2026-10-20 (passcode speed, 4 digits):** sign-in and unlock took seconds because the passcode hash (60,000 PBKDF2 rounds in `@noble/hashes`) runs in JavaScript on Hermes, which has no JIT. The passcode is now 4 digits and hashed at 1,000 rounds (`mobile/src/lib/security/passcode.ts`): with 10,000 possible codes, extra rounds never protected it; the device-only keychain item and the 5-try sign-out do. Records are now `v: 2`; an older 6-digit (`v: 1`) record is dropped at launch and the phone asks for a new passcode without signing out. JS-only, no rebuild needed. Not yet timed on a device.
- **2026-10-20 (mobile theme matches the web):** colour tokens already matched the web exactly; what differed was the Home band, which was navy in light mode (with a fixed light status bar) while the web dashboard's band is the pale `brand-surface`. Mobile now has the `brand-surface` tokens and Home uses them (pale in light, #1c2d3f in dark), with a pinned strip behind the status bar. `FocusStatusBar` follows the app theme. New appearance choice under More (System, Light, Dark), stored in a document file and applied with `Appearance.setColorScheme` so native UI follows; the window background tracks the theme (`expo-system-ui`); Android's tab bar uses app colours instead of Material You. The entrance (auth, passcode, lock) stays navy. JS-only, no rebuild. Not yet checked on a device.
- **2026-10-20 (biometric sign-in + mobile slice 2):**
  - Backend: biometric sign-in keys (see the status table); `listSessions` returns `biometricSignIn`. `bun run dev:mock --seed` adds a demo business with three branches, balances and 56 payments over two weeks. `tests/biometric.test.ts` (10); the suite passes 72/72.
  - Mobile: biometric sign-in (store, `security/biometrics.ts` vault, welcome, sign-in, setup offer, More, devices). Slice 2: `(app)` tabs are now Home (`(home)` stack: deck, account details, payment, switch business), Payments (`payments/` stack: list, detail, filters) and More. Details push inside each tab's stack instead of opening as native sheets, because native sheets would draw above the JS lock screen and privacy cover. Large titles are off in `stackScreenOptions` (iOS 26 inside NativeTabs reserves the space but doesn't draw them). `tsc` and lint pass.
  - ⚠️ At 18:48 someone started `bun run dev` (the real backend with the live `backend/.env`) on :4000, and `mobile/.env.local` points the app at it, so the simulator is showing live data (Carniel Business). This session didn't start it and didn't sign in through it. Use `dev:mock --seed` for testing.
  - Left: `ios/Info.plist` still has the old Face ID text; run `bunx expo prebuild -p ios` (or the next clean build) to pick up the new `app.json` string. None of biometric sign-in, Payments, the filters or the switcher has been run on a device; Android still hasn't been built.
- **2026-10-20 (More header, Lock now):** large-title headers inside NativeTabs on iOS 26 reserved ~100pt but drew no title (blank band on More and Payments); `stackScreenOptions` and `more/_layout.tsx` now use standard inline headers. "Lock now" only flashed the lock screen because it asked for Face ID straight away and Face ID passed in ~350ms (logged on the simulator); the store now records `lockedByUser` and the lock screen waits for a tap on the Face ID key after a manual lock. Auto-lock (launch, 60 s background, 5 min idle) still asks straight away. Not yet tapped through on a device. Heads-up: a `bun run dev` backend (real `backend/.env`, live Liquifia keys, Atlas) was found on port 4000 from 18:48, not started by an agent; the product owner was told to switch to `dev:mock`.
- **2026-10-20 (mobile slice 4: team, branches, settings):** built ahead of slice 3 at the product owner's request. Team tab, branches add/edit under More, invite links (`invite/[token]` at the root, outside the auth guards, with a pending-invite resume after sign-in), Business, Profile and Two-step verification screens, shared `OptionList`/`OptionRow`, `DetailList`, `HeaderButton`, `lib/permissions.ts` (mirrors the web). Home's greeting row is now fixed (product owner's request). The deck reads `balance.availableKobo` when the Transfers backend adds it. `tsc` and lint pass; none of the new screens has been tapped through (the simulator was on the live backend). No backend changes.
- **2026-10-20 (mobile Transfers, finished after a crashed session):** an earlier session built the mobile Transfers screens (`payments/send`, `banks`, `review`, `transfers`, `transfer/[id]`, `lib/api/transfers.ts`, `lib/send-draft.ts`, `ConfirmPasscode`, `TransferRow`) and stopped before wiring them in or logging them. This session finished the wiring: Send money on each Home card (`onSend` was in the deck but Home never passed it), the Home "N transfers need your approval" banner (`useAwaitingCount` had no caller), the count on the "Needs your approval" tab, the approval rule line on Transfers, and a new `payments/approval-rule.tsx` (the approval-rule hooks had no screen). Mobile `tsc` and lint pass; backend 88/88 tests and typecheck pass; web typechecks. Nothing has been tapped through on a device. Not done: bulk transfers on mobile. The backend and web Transfers rows in §3, §4 and "Next up" item 1 still describe Transfers as not built; the sessions that built them (still running) should update those.
- **2026-10-20 (branch accounts without BVN + Transfers):** built in a session that crashed (the VS Code extension restarted at 19:41) before it updated this file; finished and checked in a follow-up session.
  - Branch customers no longer send a BVN (Liquifia doesn't need one); only the business's own customer (head office) carries the principal's BVN. With the product owner's go-ahead, the live branch **Island Outlet** (`6ab6fd7cbb94f00c4ae079a0`) was retried once: new customer `cmvh1fm1t0jrun6hucvism3ma`, account **8881838659** "Carniel Business Island Outlet" (Rubies MFB), status `active`. The head office account 8881798495 was untouched. Live data now: Carniel Business has 2 branches, both active.
  - Transfers backend (see the status table and API summary): 88/88 tests pass, `tsc` clean. Checked end to end over HTTP against `dev:mock --seed`: name enquiry, unknown account, fee with stamp duty, bank, branch-to-branch and bulk transfers, idempotent replay, insufficient balance, a bulk transfer with a bad row, `NO_APPROVER`, then every transfer settling to `success`, the head office debited amount + fees, nothing left held, the receiving branch credited, and payout debits plus the incoming credit in Transactions.
  - Mock: `startMockLiquifia({ autoSettlePayoutsMs })` settles payouts on its own (dev only), and a successful payout to one of the mock's accounts credits it and appears as an inbound transfer. `dev:mock` now runs the transfer follow-up (5 s) and the inbound sync (10 s), so transfers move from "processing" to "success" within seconds.
  - Transfers web is built; its browser run against the mock is in the next entry.
  - ⚠️ The `bun run dev` backend on :4000 (live `.env`, started 18:48) reloaded with this code, so it now runs the transfer follow-up against live Liquifia every minute. It only acts on transfers in `processing`, and none exist live, but **any transfer created through it moves real money**. Use `dev:mock` for testing.
- **2026-10-20 (Transfers web fixes):** `/transfers` crashed for every approved business: the server page called `describeApprovalRule()` from a `"use client"` file. Moved it to `lib/transfers.ts`. The transfer and transaction detail sheets were 3/4 width on phones with content cut off, and 384px instead of 448px on desktop, because the sheet's `data-[side=right]:w-3/4` / `sm:max-w-sm` beat the plain `w-full` / `sm:max-w-md`. Both now override with `data-[side=right]:` variants. Browser run (Playwright) against `dev:mock --seed` on :4100 with a copy of `web/` on :3100 (a second `next dev` can't run in `web/` while the :3000 one is up): single transfer to "Sent", sheet, bulk row errors, approval rule dialog, 375px; no page errors. `tsc` and lint pass. Small gap: the bulk CSV doesn't recognise common short bank names such as "GTB".
