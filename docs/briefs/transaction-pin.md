# Transaction PIN (H13)

**Decided:** 2026-10-23. The product owner chose a 4-digit transaction PIN that the server checks.

Money movements and security settings need this PIN, which is separate from the password and from the mobile app's unlock passcode. The backend is done; this brief is the contract the web and mobile apps build against.

## How a covered request carries the PIN

- Send it in the header **`X-Transaction-Pin: 1234`** (4 digits). The backend removes the header before handlers and logs see it.
  - **Web:** add the header server-side, in the server action, through the API client's extra headers. The PIN must never land in a URL, cookie or local storage.
  - **Mobile:** add it to that one request only. Never store it.
- Checks run in this order: auth → business → permission → PIN → handler.
  - A member without permission gets `PERMISSION_DENIED`, and no PIN attempt is used up.
  - A right PIN counts as right even if the action then fails, for example with `INSUFFICIENT_BALANCE`.
- A replay with the same Idempotency-Key still needs the PIN. Keep the same Idempotency-Key when retrying after a PIN error, since nothing was done.

## Covered routes

| # | Method and path | What it is |
| --- | --- | --- |
| 1 | `POST /api/transfers` | Send a single transfer |
| 2 | `POST /api/transfers/bulk` | Bulk transfer |
| 3 | `POST /api/payout-lists/:id/run` | Run a payout list |
| 4 | `POST /api/transfers/:id/approve` | Approve one transfer |
| 5 | `POST /api/transfers/batches/:id/approve` | Approve a batch |
| 6 | `POST /api/safelocks` | Create a Safelock |
| 7 | `POST /api/pockets/:id/withdraw` | Withdraw from a pocket |
| 8 | `POST /api/pockets/:id/close` | Close a pocket (money goes back to the account) |
| 9 | `PATCH /api/transfers/settings` | Change the approval rule or workflow |
| 10 | `POST /api/team/invites` | Invite a member |
| 11 | `POST /api/team/invites/:id/resend` | Resend an invite (issues a fresh link) |
| 12 | `PATCH /api/team/members/:id` | Change a member's role or branches |
| 13 | `DELETE /api/team/members/:id` | Remove a member |
| 14 | `POST /api/payout-lists` | Create a payout list |
| 15 | `PATCH /api/payout-lists/:id` | Edit a payout list |

**Not covered:**
- Rejecting or cancelling transfers.
- Creating a pocket, depositing into one, or changing its auto-save rules.
- Renaming a Safelock or deleting a payout list.
- Revoking an invite or leaving a team.
- Beneficiaries and branches.

## Errors on covered routes

| `code` | Status | Meaning | What the client does |
| --- | --- | --- | --- |
| `TRANSACTION_PIN_REQUIRED` | 403 | The user hasn't set a PIN | Open the set-PIN flow (password + new PIN), then continue the action |
| `TRANSACTION_PIN_MISSING` | 403 | A PIN is set, but the header is missing or isn't 4 digits. It doesn't count as an attempt | Ask for the PIN |
| `TRANSACTION_PIN_INVALID` | 403 | Wrong PIN. `details.attemptsLeft` is 1–4 | Show "Wrong PIN. N tries left." and ask again |
| `TRANSACTION_PIN_LOCKED` | 429 | Locked after 5 wrong PINs. `details: { lockedUntil, retryAt, attemptsLeft: 0 }` | Show when it unlocks, and offer "Reset PIN" |

## PIN endpoints

All of these need the Bearer token. The status object looks like this: `{ isSet, locked, lockedUntil: ISO|null, attemptsLeft: number|null, changedAt: ISO|null }`.

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/transaction-pin` | none | 200, status | none |
| `POST /api/transaction-pin` | `{ pin, password }` | 201, status | `WEAK_TRANSACTION_PIN` 400, `TRANSACTION_PIN_ALREADY_SET` 409, `INCORRECT_PASSWORD` 400, `PASSWORD_NOT_SET` 400 |
| `POST /api/transaction-pin/change` | `{ newPin, currentPin }` **or** `{ newPin, password }` (exactly one) | 200, status | `WEAK_TRANSACTION_PIN`, `TRANSACTION_PIN_REQUIRED`, `TRANSACTION_PIN_INVALID` (a wrong currentPin counts), `TRANSACTION_PIN_LOCKED`, `INCORRECT_PASSWORD` |
| `POST /api/transaction-pin/reset/request` | none | 200 `{ message, sentTo }`; emails a 6-digit code valid for 10 minutes | `TRANSACTION_PIN_REQUIRED`, `OTP_COOLDOWN` 429 with `details.retryAt` |
| `POST /api/transaction-pin/reset` | `{ password, code, newPin }` | 200, status; also ends a lock | `WEAK_TRANSACTION_PIN`, `TRANSACTION_PIN_REQUIRED`, `INCORRECT_PASSWORD`, `INVALID_CODE` 400 |

- **Weak PINs** are refused with `WEAK_TRANSACTION_PIN`: four identical digits, or a straight run up or down (1234, 9876, 0123). Clients should say so before submitting.
- **Rate limits:** the POSTs are limited to 20 per 15 minutes per user (429).
- **Security emails:** the user gets one whenever the PIN is set, changed, reset or locked.
- **Passwordless accounts:** an account verified without its sign-up password has none (`hasPassword: false`) and gets `PASSWORD_NOT_SET`. Send the user to reset their password first.

## Lockout

- 5 wrong PINs in a row lock PIN use for 30 minutes, and the user gets an email.
- Each attempt is counted atomically before the comparison.
- A right PIN, the lock ending, a change or a reset sets the count back to zero.

## Rollout

Every existing user starts without a PIN, so all 15 routes return `TRANSACTION_PIN_REQUIRED` until they set one. The set-PIN flow therefore has to ship with the backend.

Clients should handle this so it doesn't feel like an error. The first time someone confirms a covered action, they set their PIN (password + new PIN, entered twice), and the action then goes ahead.

In the dev seed, `swift@linkpay.test` has the PIN `1357`. `demo@linkpay.test` has none, so the set-PIN flow can be tried there.

## Batch 8 changes (2026-10-25)

- **Daily cap.** Wrong PINs are counted over a rolling 24 hours, counted atomically before the PIN is compared. The 15th wrong PIN in a day locks the PIN **until it is reset**; no timer ends that lock.
  - The response is 429 `TRANSACTION_PIN_LOCKED` with `details: { lockedUntil: null, retryAt: null, attemptsLeft: 0, resetRequired: true }`.
  - The user gets an email, and only `POST /api/transaction-pin/reset` clears the lock.
  - The 30-minute lock after 5 wrong PINs in a row still applies. It now carries `resetRequired: false`.
  - A right PIN takes its own try back off the day's count; earlier wrong ones stay counted.
- **Status and attempts.** The status object adds `resetRequired: boolean`. `attemptsLeft` is the smaller of the tries left in a row and the tries left today.
- **Weak PINs.** Four of one digit, straight runs up or down, years 1950–2030, and a list of common PINs: pairs, mirrors and keypad shapes such as 1212, 1122, 1221, 2580, 1470, 0852 and 2468. The list is in `backend/src/services/transactionPin.ts`; the web (`web/src/lib/transaction-pin.ts`) and mobile copies must match, and a test checks the web copy. The seed's 1357 is still allowed.
- **Changing the PIN with the password** still needs no emailed code, a deliberate choice. Every password re-check is now rate-limited, sharing one count of 10 failures per 15 minutes per user, and every change is emailed. To close the remaining risk (a phished password plus a stolen session), drop `{ newPin, password }` and send people to reset. That would be a contract change for both clients.
- **Mobile.** The weak-PIN list in `mobile/src/lib/api/transaction-pin.ts` matches the backend's. When `resetRequired` is true, the PIN sheet and More › Transaction PIN say the PIN is locked until it's reset, show no countdown, and offer "Reset your PIN".
