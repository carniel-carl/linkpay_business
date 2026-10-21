# Brief: staff roles and staff invites (backend)

Product owner's request, 2026-10-21: the admin console needs **different staff roles**. A **super admin** invites new staff, picks their role, and can change it later. Every other staff member can only do what their role allows.

This builds on [staff-admin.md](staff-admin.md) (Part A is done: `Staff`, `StaffSession`, `requireStaff`, `/api/admin/auth`). This brief covers only the backend. The `admin/` app screens (staff list, invite form, accept-invite page, hiding actions the role can't use) come later, in a separate session, built from the contract below.

Read first: `CLAUDE.md`, `backend/CLAUDE.md`, `docs/IMPLEMENTATION.md`. Nothing here calls Liquifia. Test with `bun test` and `bun run dev:mock`.

## 1. Roles and permissions

Use the same approach as business team roles (`src/config/permissions.ts`): fixed roles built from permissions. Code checks **permissions, never role names**. Put the staff ones in `src/config/staffPermissions.ts`.

| Permission | Allows |
| --- | --- |
| `businesses.view` | `GET /summary`, `GET /businesses`, `GET /businesses/:id` |
| `documents.view` | `GET /businesses/:id/documents/:documentId/file` (KYB documents hold personal data) |
| `kyb.review` | `POST /businesses/:id/approve`, `/request-changes`, `/reject` |
| `accounts.provision` | `POST /businesses/:id/provision-account`, `/branches/:branchId/provision-account` |
| `transactions.sync` | `POST /transactions/sync` |
| `users.view` | `GET /users`, `GET /users/:id` |
| `staff.manage` | Everything under `/api/admin/staff` (invites, role changes, disable, enable, sign out) |

| Role (`role` value) | Label | Permissions |
| --- | --- | --- |
| `super_admin` | Super admin | all of the above |
| `compliance` | Compliance reviewer | `businesses.view`, `documents.view`, `kyb.review`, `users.view` |
| `operations` | Operations | `businesses.view`, `accounts.provision`, `transactions.sync`, `users.view` |
| `support` | Support (read only) | `businesses.view`, `users.view` |

These four roles are a proposal; the product owner may rename or adjust them. Keep the role list in one place so that's a one-file change. Each role needs a one-line description for the invite form.

## 2. Model changes

- `Staff.role`: required, enum of the roles above. Also add `invitedBy` (ref `Staff`, optional).
- A `StaffInvite` model (collection `staffInvites`), mirroring the business `Invite`: `email` (lowercase), `role`, `invitedBy`, `tokenHash` (store a hash, never the raw token), `expiresAt` (7 days), `acceptedAt`, `revokedAt`, `lastSentAt` (for a resend cooldown, like `INVITE_COOLDOWN`). Only one open invite per email.
- Existing staff: `scripts/migrate-staff.ts` gives migrated admins `super_admin`. Staff with no `role` in the database (created before this change) are given `super_admin` by a small idempotent backfill. Fold it into `migrate-staff.ts` or a new `scripts/migrate-staff-roles.ts`, dry run by default with `--apply`.
- `scripts/staff.ts add` takes `--role <role>`, default `super_admin` (the first super admin is created from the command line, since nobody can invite yet). Add `set-role <email> <role>`. `list` prints the role.
- `scripts/dev-seed.ts`: keep `staff@linkpay.test` as `super_admin`. Add one seeded staff member per other role (`compliance@linkpay.test`, `operations@linkpay.test`, `support@linkpay.test`, all `password123`) so each can be tried.

## 3. Guarding the admin API

- Add `requireStaffPermission("…")` in `src/middleware/staff.ts`. It reads the role fresh on every request (`requireStaff` already loads the staff document; select `role` there and set `req.staffRole` / `req.staffPermissions`), so a role change or a disable takes effect on the next request. Missing permission: **403 `STAFF_PERMISSION_DENIED`**.
- Put a permission on **every** route in `src/routes/admin.ts`, as in the table in §1. No route is left with only `requireStaff`.
- `GET /api/admin/auth/me` (and the `staff` object in the `login/2fa` response) adds `role` and `permissions: string[]`, so the admin app can hide actions.
- The admin business responses currently include `customerId` and `lastError` for every staff member. That's fine for now; note it in open questions if you think support shouldn't see them.

## 4. Staff management API: `/api/admin/staff` (all `staff.manage`)

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /roles` | | `200 [{ role, label, description, permissions }]`. Any signed-in staff can call this one (no `staff.manage`), so the app can label roles. |
| `GET /` | | `200 [staff]`, each with `role`, `status`, `lastSignInAt`, `invitedBy: { _id, name } \| null` |
| `PATCH /:id` | `{ role }` | `200 staff` |
| `POST /:id/disable` | | `200 staff`; ends all their sessions |
| `POST /:id/enable` | | `200 staff` |
| `POST /:id/sign-out` | | `204`; ends all their sessions |
| `GET /invites` | | `200 [invite]` (open ones: not accepted, revoked or expired) |
| `POST /invites` | `{ email, role }` | `201 invite`; sends the invite email |
| `POST /invites/:id/resend` | | `200 invite`, with a cooldown (`INVITE_COOLDOWN` and `details.retryAt`, like business invites) |
| `DELETE /invites/:id` | | `204` (revokes) |

Rules (each with its own error code):
- A super admin can't change their own role, disable themselves or sign themselves out from here: `CANNOT_MODIFY_SELF`.
- There must always be at least one **active** `super_admin`. Demoting or disabling the last one: `LAST_SUPER_ADMIN`.
- Inviting an email that is already staff: `ALREADY_STAFF`. An open invite already exists: `INVITE_EXISTS`.
- An invite email that belongs to a business `User` is allowed. Staff and business users are separate identities, and the same person can have both.
- Unknown role: `INVALID_ROLE` (400).

## 5. Accepting an invite (public, under `/api/admin/auth`, rate limited like login)

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /invites/:token` | | `200 { email, role, roleLabel, invitedBy: { name }, expiresAt }`. Errors: `INVITE_NOT_FOUND`, `INVITE_EXPIRED`, `INVITE_CLOSED` (accepted or revoked). |
| `POST /invites/:token/accept` | `{ name, password }` | Creates the `Staff` (role from the invite, `invitedBy`, email two-step), marks the invite accepted, sends an email code, and returns `200 { challengeToken, method: "email" }`, exactly like `POST /login`. The new staff member then finishes with `POST /login/2fa`. The same password rules as sign-up apply. |

- The invite link is `${ADMIN_APP_URL}/invite/<token>`. Add `ADMIN_APP_URL` to `src/config/env.ts` (dev default `http://localhost:3001`) and to §2 of IMPLEMENTATION.md.
- The email goes through the email provider (`src/services/email.ts`), so in development it's printed to the console, like the other emails.

## 6. Tests (`tests/staffRoles.test.ts`; update `tests/admin.test.ts` and `tests/staff.test.ts`)

- Each role: allowed routes succeed and the others get 403 `STAFF_PERMISSION_DENIED`. Use one table-driven test over the route list, so a new route without a permission is caught.
- A role change or disable takes effect on the next request with the same token.
- The invite flow: create, then preview, accept, 2FA, sign in with the new role. Also cover expired, revoked, already accepted, resend cooldown, `ALREADY_STAFF` and `INVITE_EXISTS`.
- `LAST_SUPER_ADMIN` and `CANNOT_MODIFY_SELF`.
- A non-super admin can't call `/api/admin/staff/*`, except `GET /roles`.
- The role backfill and migration: staff with no role become `super_admin`, and running it twice changes nothing.
- `signStaffToken` in `tests/helpers.ts` takes a role.

Then run the whole suite and `bunx tsc --noEmit`.

## 7. Docs

In `docs/IMPLEMENTATION.md`:
- Update the backend status table with a "Staff roles and invites" row.
- In §4, add `/admin/staff` and the invite routes to the Admin auth row, add `role`/`permissions` to `staff`, and add the new error codes.
- In §2, add `ADMIN_APP_URL`.
- Under Next up, add "admin/ app: staff page, invites, accept-invite page, hide actions by permission".
- Add a session-log line.

Don't run any migration with `--apply` against Atlas without the product owner's go-ahead.

## Contract changes

(Write any change from the contract above here, for the session that builds the admin/ screens.)

Backend built 2026-10-21. Differences from the contract above, and details it left open:

- **Staff objects** (`/me`, `login/2fa`, `/admin/staff` responses) are `{ _id, name, email, role, permissions[], status, twoFactor: { method }, lastSignInAt, createdAt }`. In `GET /admin/staff` and the `PATCH`/`disable`/`enable` responses they also carry `invitedBy: { _id, name } | null` and `isYou` (to hide self-actions).
- **Invite objects** (`GET /invites`, `POST /invites`, resend): `{ _id, email, role, roleLabel, status, expiresAt, lastSentAt, invitedBy: { _id, name } | null, createdAt }`. `status` is `pending` in the open list.
- `GET /api/admin/auth/invites/:token`: `invitedBy.name` can be `null` if the inviter was deleted. `INVITE_NOT_FOUND` is 404; `INVITE_EXPIRED` and `INVITE_CLOSED` are 410.
- `POST /api/admin/auth/invites/:token/accept`: `ALREADY_STAFF` (409) if the email became staff after the invite was sent. A password under 8 characters is a 400 validation error, as in sign-up.
- `STAFF_PERMISSION_DENIED` includes `details.required` (the permissions the route needs).
- `CANNOT_MODIFY_SELF` also covers `POST /:id/enable`. Unknown staff ids: 404 `STAFF_NOT_FOUND`; unknown invite ids: 404 `INVITE_NOT_FOUND`. Resending or revoking an invite that's accepted or revoked: 409 `INVITE_CLOSED`. Creating an invite for an email whose open invite has expired replaces it.
- `LAST_SUPER_ADMIN` can't happen through the API with today's roles (only super admins manage staff, and they can't change themselves). It protects `scripts/staff.ts set-role`/`disable` and any future role with `staff.manage`. The screens should still handle it.
- Emails with leading or trailing spaces fail validation (400), the same as business invites; trim in the form.
