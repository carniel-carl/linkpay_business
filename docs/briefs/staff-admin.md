# Brief: LinkPay Business admin as its own project, with staff accounts

Product owner's decision, 2026-10-20. LinkPay Business admin (the staff who review KYB and fix account setup) becomes **its own project with its own accounts**. Today a staff member is a normal business `User` with `role: "admin"`, so a staff account that signs in to the mobile app lands in the business interface ("Set up your business"). After this change, staff and business users are different identities that can't sign in to each other's apps.

This brief covers all of it, in three parts, done in this order:

- **A. Backend:** staff accounts, staff sign-in, and moving `/api/admin/*` onto them.
- **B. `admin/`:** a new Next.js app holding the staff console, with its own sign-in.
- **C. `web/`:** remove the admin console and the `role` checks.

The **mobile app needs no change.** Once staff aren't `User`s, a staff email can't sign in to mobile (the bug that started this). Another session is working in `mobile/` (business onboarding), so leave `mobile/` alone. Write any change to the API below in "Contract changes" at the end of this file.

Read first: `CLAUDE.md`, `backend/CLAUDE.md`, `docs/IMPLEMENTATION.md`.

## Coordinate before you start

Another session is working in `backend/` on branch accounts without a BVN: `src/services/accounts.ts`, the `Branch`, `Business` and `VirtualAccount` models, and `tests/branches.test.ts`. This brief changes **one line** in `src/models/Business.ts` (`reviewedBy`'s `ref`). Message that session before you edit it (ListAgents, then SendMessage), or ask it to make that change. Don't touch its other files.

The `.env` holds **live** Liquifia keys. Nothing here calls Liquifia. Test against the in-memory setup (`bun test`, `bun run dev:mock`).

## Part A. Backend

### 1. `Staff` model (`src/models/Staff.ts`, collection `staff`)

- `name`, `email` (unique, lowercase), `password` (hashed the same way as `User`, `select: false`), `status: "active" | "disabled"` (default active), `lastSignInAt`.
- `twoFactor: { method: "email" | "totp", totpSecret (select: false), pendingTotpSecret (select: false) }`. **Two-step is mandatory for staff.** The method defaults to `"email"` and can be switched to `"totp"`. There's no "off".
- `toJSON` strips `password`, `__v` and the secrets, as `User` does.

### 2. Staff tokens and sessions

- A `StaffSession` model: `staff`, `createdAt`, `lastUsedAt`, `expiresAt` (12 h absolute), `revokedAt`, `userAgent`, `ip`. Idle timeout 60 min, checked and extended on each request (write `lastUsedAt` at most once a minute).
- Access token: HS256 JWT signed with a **separate secret** `STAFF_JWT_SECRET` (in `src/config/env.ts`; required in production, falls back to a dev value otherwise, and `tests/setup.ts` sets it). Claims: `typ: "staff_access"`, `sub` = staff id, `sid` = session id, expiry = the session's `expiresAt`. Separate secrets and types mean neither side can verify the other's token.
- Challenge token for the second step: `typ: "staff_2fa_challenge"`, 10 minutes, same secret.
- `requireStaff` middleware (`src/middleware/staff.ts`): Bearer token → verifies with the staff secret → active session → staff `status: "active"`. Sets `req.staffId` and `req.staffSessionId`. Failures:
  - No token: 401 `UNAUTHENTICATED`.
  - Bad, expired or wrong-type token (including a business token): 401 `INVALID_STAFF_TOKEN`.
  - Revoked or idle-expired session: 401 `STAFF_SESSION_ENDED`.
  - Disabled staff: 403 `STAFF_DISABLED`.
- The business `requireAuth` must keep rejecting staff tokens. It already will because the secret differs; add a test.

### 3. Routes: `src/routes/staffAuth.ts` mounted at `/api/admin/auth`

All routes are rate limited like `/api/auth` (30 per 15 min per IP; off in tests).

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /login` | `{ email, password }` | `200 { challengeToken, method: "email" \| "totp" }`. For email, a 6-digit code is sent (reuse `src/services/otp.ts` with a staff purpose; the console prints it until email is wired). Wrong email or password: 401 `INVALID_CREDENTIALS` (same message for both). Disabled: 403 `STAFF_DISABLED`. |
| `POST /login/2fa` | `{ challengeToken, code }` | `200 { accessToken, expiresAt, staff }` and a new `StaffSession`. Wrong code: 401 `INVALID_CODE`. Bad challenge: 401 `INVALID_STAFF_TOKEN`. |
| `POST /login/2fa/resend` | `{ challengeToken }` | `200 { message, retryAt }`. Email method only, with the same cooldown as business OTPs (`OTP_COOLDOWN`). |
| `GET /me` | | `200 staff` (requireStaff) |
| `POST /logout` | | `204`, revokes the current session (requireStaff) |
| `POST /2fa/totp/setup` | | `200 { secret, otpauthUrl }` with issuer "LinkPay Staff" (requireStaff) |
| `POST /2fa/totp/enable` | `{ code }` | `200 staff` (requireStaff) |
| `POST /2fa/email/enable` | `{ password }` | `200 staff`, switches back to email codes (requireStaff) |
| `POST /password` | `{ currentPassword, newPassword }` | `204`, revokes the staff member's other sessions (requireStaff). Same password rules as business sign-up. |

`staff` in responses is `{ _id, name, email, status, twoFactor: { method }, lastSignInAt, createdAt }`.

### 4. Move the admin API onto staff auth

- `src/routes/admin.ts`: replace `requireAuth, requireAdmin` with `requireStaff`. The paths stay the same (`/api/admin/summary`, `/businesses`, ...). Business tokens now get 401 `INVALID_STAFF_TOKEN` there; the old 403 test changes.
- `src/controllers/admin.ts`: use `req.staffId` for `reviewedBy`. `Business.reviewedBy` becomes `ref: "Staff"` (coordinate, see above). Where admin responses show who reviewed, read the name from `Staff`.
- `src/routes/users.ts`: drop the `requireAdmin` list and get routes from the business API. If staff need them, add `GET /api/admin/users` and `GET /api/admin/users/:id` under `requireStaff`.
- Delete `requireAdmin` and the `role` field on `User`. Business `GET /api/auth/me` no longer returns `role`.

### 5. Migration and scripts

- `scripts/migrate-staff.ts` (idempotent; dry run by default, `--apply` to write). For every `User` with `role: "admin"`:
  - Create a `Staff` with the same name, email and password hash, on email two-step.
  - If the user owns no business and has no memberships, delete the `User` and its sessions and biometric keys. It was staff only. Otherwise keep it as a normal business user.
  - Unset `role` on every user.
  - Print a summary.
- Replace `scripts/make-admin.ts` with `scripts/staff.ts`: `add <email> "<name>"` (asks for the password with Bun's `prompt()`, or takes `--password` for dev), `disable <email>`, `enable <email>`, `list`, `sign-out <email>` (revokes all sessions).
- `scripts/dev-seed.ts` (`dev:mock --seed`): also create staff `staff@linkpay.test` / `password123` on email two-step, so the code prints to the console.
- `package.json` scripts: `migrate:staff`, `staff`.

### 6. Tests (`tests/staff.test.ts`, and update `tests/admin.test.ts`)

Cover:
- Login, then the 2FA step: email and TOTP methods, wrong code, resend cooldown, disabled staff.
- A staff token is rejected by `/api/business`, `/api/auth/me` and `/api/accounts`. A business token, including an old `role: "admin"` user's, is rejected by `/api/admin/*`.
- Logout revokes the session, idle and absolute expiry work, and a password change signs out other sessions.
- The migration: a staff-only user is moved and deleted, a staff user who owns a business is moved and kept, and running it twice changes nothing.
- `admin.test.ts` signs in as staff, with a `signStaffToken` helper in `tests/helpers.ts`.

Then run the whole suite and `bunx tsc --noEmit`.

### 7. Docs

Update `docs/IMPLEMENTATION.md`: the backend status table (a new "Staff accounts" row; edit the admin row), §4 (a new `Admin auth /admin/auth` row; the Admin row now says staff token; `role` removed from Users), §2 (`STAFF_JWT_SECRET`), and a session-log line. Say whether the migration has been **run** against the real database. Don't run it with `--apply` against Atlas without the product owner's go-ahead; it deletes users.

## Part B. The `admin/` app

The staff console moves out of `web/src/app/admin` into its own Next.js project at the repo root, `admin/`. It uses the same stack, design and conventions as `web/` (read `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`), runs on **port 3001**, and talks to the same backend server-side only (server actions and route handlers, like the web).

**Starting point (already done, half finished):** `admin/` is a copy of `web/` (config, `globals.css`, fonts, `components/ui`, `data-table`, `auth`, `common`, `brand`, `business`, `accounts/copy-button`) with the business parts deleted:
- The console pages moved from `app/admin/*` to `app/(console)/*`, so they serve at `/`, `/businesses` and `/businesses/[id]`.
- The document route moved to `app/api/files/[businessId]/[documentId]`.
- `DocumentStatus` moved to `components/admin/document-status.tsx`.
- `node_modules` hasn't been installed yet.

**It doesn't build yet.** To finish:
1. **Paths.** Replace every `/admin` path with the root one: `/admin` → `/`, `/admin/businesses…` → `/businesses…`, `/api/files/admin/` → `/api/files/`, and the `PageProps<"/admin…">`, `LayoutProps<"/admin">` and `RouteContext<…>` generics. They're in `app/(console)/*`, `components/admin/admin-sidebar.tsx`, `businesses-table.tsx`, `app/api/files/...` and `components/shell/user-menu.tsx`. Imports of `@/app/admin/actions` (in `review-actions`, `bank-account-panel` and `branches-panel`) become `@/app/(console)/actions`. Keep `/api/admin/...` backend calls as they are.
2. **Staff session.** In `lib/session.ts`, use the cookie `lp_staff_session` (httpOnly, `sameSite: "strict"`, `maxAge` from the token's `exp`) and the challenge cookie `lp_staff_2fa`. Drop the business cookies (`lp_business`, `lp_branch`). In `lib/api/client.ts`, drop `X-Business-Id` and the business context. On 401 `INVALID_STAFF_TOKEN` or `STAFF_SESSION_ENDED`, go to `/auth/sign-out?expired=1`.
3. **Sign-in.** `(auth)/actions.ts` calls `/api/admin/auth/login`, `/login/2fa`, `/login/2fa/resend` and `/logout`. Remove sign-up, email verification and email-code sign-in. `safeNext` defaults to `/`. The sign-in page says "Staff sign in" and has no "Open an account" link. The `(auth)/layout.tsx` aside describes the staff console, not the business requirements (`lib/requirements.ts` can go). Sign-out calls `POST /api/admin/auth/logout`, then clears the cookies.
4. **Console layout.** `app/(console)/layout.tsx` loads `GET /api/admin/auth/me`. With no session it redirects to `/sign-in?next=…`, so drop the `notFound()` role check. Drop `getOverview()`, `hasBusiness` and the sidebar's "Your business" footer. The user menu shows the staff name and email, a Security link and Sign out.
5. **Security page.** `/security`: change password, and two-step with email or authenticator app. Adapt `components/settings/security-settings.tsx`: there's no "turn off" (two-step is mandatory for staff), its actions move to `app/(console)/security/actions.ts`, and it uses the staff endpoints.
6. **Trim.**
   - `lib/data.ts`: keep the admin loaders (`getAdminBusinesses`, `getAdminSummary`, `getAdminBusiness`) and add `getStaff`.
   - `lib/api/types.ts`: drop the business-only types and add `Staff`.
   - `lib/api/errors.ts`: add the staff codes.
   - Root `layout.tsx`: title "LinkPay Staff".
   - `not-found.tsx`: link to `/`.
   - `package.json`: `"name": "admin"`, `"dev": "next dev -p 3001"`, `"start": "next start -p 3001"`. Remove dependencies nothing uses any more.
   - `.env.example`: `API_URL`.
   - Rewrite `README.md` and `CLAUDE.md` (a short one pointing at `web/DESIGN.md` for the shared design).
7. Run `bun install`, `bunx tsc --noEmit`, `bun run lint` and `bun run build`. Then sign in against `bun run dev:mock --seed` as `staff@linkpay.test`; the code prints in the backend console. Go through review, approve and request changes on a submitted business.

## Part C. Remove admin from `web/`

Another session may be working in `web/` (Transfers). Check with ListAgents first and avoid editing the same files at the same time.

- Delete `src/app/admin/`, `src/components/admin/`, `src/lib/admin.ts`, `src/app/api/files/admin/`, the admin loaders in `src/lib/data.ts` and the admin-only types.
- `src/app/(dashboard)/layout.tsx:23`: always redirect to `/onboarding` when there's no business; drop `isAdmin`.
- `src/components/shell/user-menu.tsx`: remove the staff console link.
- Remove `role` from the `User` type.
- Run `bunx tsc --noEmit`, lint and build.

## Done when

- Backend tests and typecheck pass; `admin/` and `web/` typecheck, lint and build.
- A staff account signs in only at `admin/` (port 3001). Business users sign in only on web and mobile.
- `docs/IMPLEMENTATION.md` is updated: §2 layout and how to run `admin/`, status tables, §4, "Next up", open questions (staff roles, the migration still to be run on the real database), and a dated session-log line.

## Out of scope

- Staff roles or permissions beyond one "staff" level, audit logs, SSO, invites for staff. Note them as follow-ups.

## Contract changes

(Write any change to the API above here, with the date.)

- **2026-10-21 (backend, Part A):** `business.reviewedBy` in admin responses (`GET /api/admin/businesses/:id`, approve, request-changes, reject) is now the reviewer `{ _id, name, email }` from `Staff`, or absent when not yet reviewed. Business-facing responses (`GET /api/business` etc.) no longer include `reviewedBy`. `GET /api/users` and `GET /api/users/:id` are gone (404); use `GET /api/admin/users` and `/api/admin/users/:id` with a staff token. Everything else matches the brief.
