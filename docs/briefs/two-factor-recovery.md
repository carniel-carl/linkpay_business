# Two-step recovery codes, encrypted authenticator secrets, and three auth lows (batch 9)

**Built:** 2026-10-25, on branch `fix/audit-batch-9`. Backend only; the web, admin and mobile screens build against the contract below.

Business routes are under `/api/auth` and staff routes under `/api/admin/auth`. Both work the same way except where this says otherwise.

## 1. Recovery codes

People who use an authenticator app get 10 one-time recovery codes. Each one stands in for an authenticator code once, at sign-in, for someone who has lost their phone.

### The codes

- **Format.** `xxxxx-xxxxx`, lowercase, from `abcdefghjkmnpqrstuvwxyz23456789`, so there's no 0, o, 1, l or i. That's about 49 bits per code. A set of 10 never repeats a code.
- **Shown once.** The codes are only in the response that creates them.
- **Storage.** Only a keyed hash is stored: HMAC-SHA256 over the account and the code, with a key derived from `ENCRYPTION_KEY`.
  - Someone with only the database can't test guesses offline.
  - A hash copied onto another account doesn't match there.
  - The hashes are `select: false` and never appear in any JSON.
- **Comparison.** What the person types is trimmed and lowercased, and spaces and dashes are dropped. `ABCDE FGHJK`, `abcdefghjk` and ` abcde-fghjk ` are the same code.
- **Single use.** A code is used up by removing its hash in one conditional update, so two sign-ins with the same code at once can't both get in.
- **Only with the authenticator.** Codes exist only while the method is `totp`.
  - Switching to email codes deletes them.
  - Turning two-step off (business only) deletes them too.
  - Enabling the authenticator again, for example on a new phone, replaces them.

### Endpoints

| Method and path | Auth | Body | Success |
| --- | --- | --- | --- |
| `POST /2fa/totp/enable` | signed in | `{ code }` | Business: `{ message, user, recoveryCodes }`. Staff: the staff object plus `recoveryCodes`. `recoveryCodes` is 10 codes; any earlier ones stop working. |
| `POST /2fa/recovery-codes` (new) | signed in, `authLimiter` | `{ password }` **or** `{ code }`, a current authenticator code | `{ recoveryCodes }`: 10 new codes. The old ones stop working. |
| `POST /login/2fa` | the challenge token | `{ challengeToken, code }` **or** `{ challengeToken, recoveryCode }`, exactly one. Business also takes `device`, as today | With `code`: as today. With `recoveryCode`: the same response plus `recoveryCodeUsed: true` and `recoveryCodesLeft: number`. |

**More on `POST /2fa/recovery-codes`.** It re-authenticates exactly as `POST /2fa/totp/setup` does.
- It counts towards the same shared limit: 10 failed re-checks per 15 minutes per account.
- A wrong authenticator code counts towards that account's daily limit on wrong authenticator codes.
- The method is checked before the password, so `TOTP_NOT_ENABLED` uses up no tries.

**More on `POST /login/2fa`.**
- The `user` (business) or `staff` object in a recovery-code response already shows the new count.
- Every sign-in with a recovery code emails the account. The email says how many codes are left, says when that was the last one, and says what to do if it wasn't them.
  - Business users are told to reset their password, make new codes and sign out their other devices.
  - Staff are told to change their password, make new codes and tell a super admin.
  - A failed email is logged and doesn't fail the sign-in.

**Account objects.** `twoFactor.recoveryCodesLeft: number` appears in:
- the business user JSON: `/me` and every `user` in a response;
- the serialized staff object: `/me`, sign-in, enable and switch responses, and the staff list.

It's 0 whenever the method isn't `totp`.

### Errors

| `code` | Status | When |
| --- | --- | --- |
| `INVALID_CODE` | Business **400**, staff **401** (each as before batch 9) | A wrong or used recovery code, or a wrong authenticator code |
| `TOO_MANY_ATTEMPTS` | 429 | The challenge has had its 5 tries. Authenticator and recovery codes share them. Even a right code is refused on that challenge; sign in again for a new one |
| `TOTP_NOT_ENABLED` | 400 | `POST /2fa/recovery-codes` when the method isn't `totp`, or a `recoveryCode` at sign-in when the method is email codes |
| `INVALID_TOKEN` (business) / `INVALID_STAFF_TOKEN` (staff) | 401 | A bad or expired challenge, or one issued before a password change or reset (§3a) |
| none (`Validation failed`) | 400 | At sign-in, both `code` and `recoveryCode`, or neither. On `POST /2fa/recovery-codes`, neither `password` nor `code` |
| Business: none (`Incorrect password`), staff: `INCORRECT_PASSWORD` | Business 401, staff 400 | A wrong password on re-auth, as on `/2fa/totp/setup` |
| `RATE_LIMITED` | 429 | The `authLimiter` limits |

**Clients:** check `code`, not the status. The `INVALID_CODE` status was already different for business and staff, and this keeps it as it was.

### Notes for the screens

- Offer "Use a recovery code" on the second step only when the challenge's `method` is `totp`.
- Show the 10 codes once, right after enabling or making new ones, with copy and download. Warn that they won't be shown again.
- Use `recoveryCodesLeft` on the security page to say how many are left, and suggest new codes when it's low or 0.
- After a sign-in with `recoveryCodeUsed: true`, say a code was used and how many are left.

## 2. Authenticator secrets encrypted at rest

- **What's encrypted.** `twoFactor.totpSecret` and `twoFactor.pendingTotpSecret`, for business users and staff. They use the v2 format in `utils/crypto.ts`, bound to the record and the field, as BVNs are.
  - The context is `user:<id>:twoFactor.totpSecret`, `staff:<id>:twoFactor.pendingTotpSecret` and so on.
  - A secret copied onto another account, or from the pending field to the active one, doesn't decrypt there. That sign-in fails with a 500, and no code is accepted.
- **Reading.** `services/totp.ts` `readTotpSecret()` reads v2 values and, until the migration has run, plain base32. Every new secret is written encrypted, at setup and again at enable.
- **With `ENCRYPTION_REQUIRE_V2=1`,** a plain secret is refused, as old-format values are.
  - The sign-in, or the re-auth with a code, fails with a 500.
  - The log says: "Refusing an authenticator (TOTP) secret stored in plain text: ENCRYPTION_REQUIRE_V2=1 is set. Run `bun run migrate:encryption --apply` to encrypt it, or unset ENCRYPTION_REQUIRE_V2."

### Deploy steps

1. Deploy the backend. No new env vars, and no index changes.
2. `bun run preflight`. The Database section has a new **TOTP secrets** line: WARN with the number of secrets still stored in plain text, PASS at 0.
3. `bun run migrate:encryption`. The dry run writes nothing. It now also prints "Authenticator (TOTP) secrets in plain text: N" and "Would encrypt as v2: N".
4. `bun run migrate:encryption --apply`. It rewrites each plain secret as v2, only if it hasn't changed since it was read, so it's safe while the app is up. Run it again until it reports nothing left.
   - A value that is neither encrypted nor base32 is listed and left as it is.
5. Set `ENCRYPTION_REQUIRE_V2=1` only once the last line says no values are left in the old format. That line covers BVNs and TOTP secrets together.

**`ENCRYPTION_KEY` now protects more.** It now also keys the recovery-code hashes and encrypts TOTP secrets. Changing it makes every recovery code stop working and every TOTP secret unreadable, as it already did for BVNs.

## 3. The three lows from the batch 8 re-audit

### a. The 2FA challenge carries the password stamp

- Challenge tokens, business and staff, now carry `pwd`: the account's `passwordChangedAt` in ms, or 0, as the first step loaded it.
- `/login/2fa` and `/login/2fa/resend` refuse a challenge whose stamp doesn't match the account's current one: 401 `INVALID_TOKEN` (business) or `INVALID_STAFF_TOKEN` (staff). That covers a reset or change after the challenge was issued, and one that landed while the first step was running.
- **Staff** gained `passwordChangedAt`. `POST /api/admin/auth/password` sets it. It's never in any JSON.
- **At deploy,** challenges issued before it have no stamp and count as 0. They still work for accounts whose password never changed. Everyone else gets `INVALID_TOKEN` and signs in again. Challenges last 10 minutes.
- **Staff sessions carry the stamp too** (batch 10).
  - `StaffSession.passwordChangedAt` is taken from the staff record the second step loaded.
  - A session older than the staff member's current `passwordChangedAt` gets 401 `STAFF_SESSION_ENDED`, and its notification stream ends. The check uses the same read as the role check, so it costs nothing extra.
  - The session that changed the password is re-stamped and carries on.
  - Sessions from before this have no stamp and work until the next password change. The one exception is an environment that already ran batch 9: a staff member who changed their password there signs in once more.

### b. A biometric sign-in can't race a reset into a live session

`revokeOtherSessions` (used by reset, change and "sign out other devices") now ends biometric keys before sessions, and again after them. Two checks rely on that order.

- **Sign-in.** It claims the key with a conditional update, opens the session, then checks the key is still live. If it isn't, it closes the session it just opened and answers 401 `INVALID_BIOMETRIC_KEY`.
  - A reset that ended the sessions before this one opened had already ended the key, so a session that slipped past the sign-out is always caught.
  - A session opened before the sign-out is ended by it.
  - Either way, the session stamp from batch 8 also ends a session that signed in under the old password.
- **Turning biometric sign-in on.** After saving the key, it checks the session it was made in is still live and not older than the latest password change. If not, it ends the key and answers 401 `SESSION_REVOKED`, before the secret is handed out.
- **No change otherwise.** A password change still keeps the phone that made it, with its key.

### c. Wrong emailed codes are capped per address and across addresses

This matches the batch 8 sign-in lockout. In `services/otp.ts`, wrong codes for one email and purpose over a rolling day are capped at:
- `MAX_DAILY_FAILURES = 10` per client address. IPv6 is grouped by /56, as the rate limits group it, and the address is stored only as a hash.
- `MAX_DAILY_FAILURES_ALL_CLIENTS = 50` across all addresses.

Past either cap, codes aren't compared.

- **What this fixes.** A stranger who knows the email uses up only their own address's tries, and the owner still signs in with a code from theirs.
- **What's left.** Tripping the cap across addresses still takes 5 or more addresses guessing all day. Then email codes stop for everyone that day, but password sign-in still works.
- **H2's guarantees still hold.** Each attempt is counted atomically on the code before comparing, at most 5 per code. A burst can pass a cap by at most one code's tries. So at most 55 wrong codes are ever compared per email and purpose in a day, about 1 in 18,000 a day for a 6-digit code.
- **Which checks pass the address.** Sign-in codes, email verification, business email 2FA, staff email 2FA and password reset codes now pass `req.ip`.
  - The password reset is in `controllers/password.ts`, so a stranger can't block a reset either.
  - Callers that pass no address share one bucket per email: the transaction-PIN reset, which is behind a session, and scripts. That bucket gets the per-address cap of 10.
- **Old failures.** Failures saved before this have no address. They count only towards the cap across addresses, and they expire within a day.

## Files

- **New:**
  - `backend/src/services/recoveryCodes.ts`;
  - tests: `backend/tests/recoveryCodes.test.ts`, `totpEncryption.test.ts` and `authLows.test.ts`.
- **Changed:**
  - `controllers/auth.ts`, `controllers/staffAuth.ts` and `controllers/password.ts`. In `password.ts` the only change is passing the address to the reset code check.
  - `routes/auth.ts` and `routes/staffAuth.ts`.
  - `services/totp.ts`, `otp.ts`, `biometricKeys.ts`, `staffAuth.ts`, `tokens.ts`, `sessions.ts` and `email.ts`. In `email.ts` the only change is `sendRecoveryCodeUsedEmail`.
  - `models/User.ts`, `Staff.ts` and `Otp.ts`.
  - `scripts/migrate-encryption.ts`, and one line in `scripts/preflight.ts`.
  - Tests: `tests/staff.test.ts` (the staff `twoFactor` shape) and `tests/hardening.test.ts` (the cap test uses the cap across addresses).
