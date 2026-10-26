# Brief: Money-out security (settlement accounts, step-up, freeze)

Backend done 2026-10-22 (`backend/tests/security.test.ts`, 18 tests). This is the contract for the web, admin/ and mobile clients.

**The threat.** Someone steals a business login (phished password, a session left open, a SIM-swapped inbox). Today that alone lets them send money to any account, or invite their own account and send from it. This feature makes a stolen login on its own useless for taking money, and gives the real team time and tools to stop an attempt.

## 1. Research: how business banks and processors handle it

| Control | Where it comes from | What we do |
| --- | --- | --- |
| **Payout account must be the business's own** | Paystack only allows a settlement account whose name matches the business's verified details (a corporate account for registered businesses, the owner's personal account for starter/sole businesses). [Paystack: change payout account](https://support.paystack.com/hc/en-us/articles/360009881860) | Name enquiry, then a word-based name match against the business name and its verified principals. Personal accounts are a full match only for sole traders and partnerships. |
| **Payouts paused after a bank change, identity re-checked** | Platforms built on Stripe pause payouts after a bank change until an identity check passes. [Slick/Stripe FAQ](https://help.getslick.com/en/articles/14627157-stripe-payouts-paused-faq-s-bank-account-change) | Every new settlement account waits for a **LinkPay staff review with a call back** to a number from the KYB file. |
| **Cooling-off for new payees** | Banks hold new beneficiaries before they can be paid (DBS 12 hours, HDFC with alerts; 24 to 72 hours recommended). [Forbes: DBS cooling period](https://forbesla.com/dbs-to-impose-12-hour-cooling-period-for-adding-new-payees-raising-daily-transfer-limits/), [HDFC cooling period](https://www.hdfcbank.com/personal/useful-links/security/security-measures/cooling-period) | **24 hours** before a new settlement account can be used (even once approved); **72 hours** to turn off "settlement accounts only". |
| **Callback verification on a number already on file, dual control** | BEC guidance and the OCC payments handbook: verify bank-detail changes out of band; dual control and segregation of duties. [Adaptive Security](https://www.adaptivesecurity.com/blog/business-email-compromise-payment-verification), [OCC handbook](https://www.occ.gov/publications-and-resources/publications/comptrollers-handbook/files/payment-sys-funds-transfer-activities/pub-ch-payment-systems.pdf) | The reviewer must tick "called back" to approve; the detail page shows only the phones and emails from verification. Maker (business owner) and checker (LinkPay staff) are different people. Existing approval rules still apply to every withdrawal. |
| **Step-up / transaction signing (dynamic linking)** | PSD2 SCA: the code must be tied to the amount and payee, single use, and any change voids it. OWASP ASVS 2.26: re-authenticate before sensitive operations, server-side. [Twilio: dynamic linking](https://www.twilio.com/en-us/blog/dynamic-linking-psd2), [OWASP ASVS 2.26](https://owasp-aasvs4.readthedocs.io/en/latest/requirement-2.26.html) | Every money-out action needs a **fresh code bound to the action and its exact details**. The server rebuilds the details from the real request; a code for ₦5,000 to A can't send ₦500,000 to B. The email code states what it confirms. Authenticator codes can't be reused (last time-step stored). |
| **Withdrawal hold after security changes** | Exchanges block withdrawals for 24 hours after a password, email or 2FA change. [Binance.US](https://www.binance.us/en/security), [PDAX protection period](https://support.pdax.ph/support/solutions/articles/1060000154851-what-is-the-account-protection-period-) | **24 hours** with no money out after any two-step change (including turning it on: an attacker with only a password could otherwise add their own authenticator). |
| **New devices and users start limited** | CBN instant-payment rules (July 2026): device binding, a low limit for 24 hours on a newly activated app, MFA to change limits, fraud monitoring on outflows. [Mondaq summary](https://www.mondaq.com/key-regulatory-update-cbn-guidelines-on-instant-payment-functionalities-and-mobile-banking-security/1773436) | A new team member (or one moved to a role that moves money) waits **24 hours** before sending or approving. |
| **Alerts with a kill switch** | Banks alert on new payees and let the customer stop them. | Owners and admins get an email per change with a personal **"This wasn't me"** link, and any money-handling member can **freeze** all money out in one click. |

## 2. Product decisions

| Decision | Detail |
| --- | --- |
| Transfers stay | (Product owner, 2026-10-22: "Business chooses".) Transfers to any account remain, with every protection below. A business can turn on **"Settlement accounts only"**: money then leaves only to active settlement accounts and between its own branches. Turning it on is immediate; turning it off needs a LinkPay review **and** 72 hours. |
| Settlement review | (Product owner, 2026-10-22.) Name check, then LinkPay staff review with a call back, **and** a 24-hour cooling-off. Owners and admins are emailed with a "This wasn't me" link. |
| Who manages | `settlement.manage`: **owner only** (admins lost it). Adding also needs two-step verification turned on and the password typed again. |
| Who freezes | `security.freeze`: owner, admin, finance, approver. The owner unfreezes a member's freeze with a code; a freeze from a report or by staff is lifted only by staff. |
| Step-up | Required for: transfers (single, bulk), approving (single, batch), running a payout list, adding/removing a settlement account, withdrawing, turning "settlement accounts only" on or off, unfreezing. **Not** for moving money between the business's own branches, rejecting, cancelling, or freezing. |
| Method | The person's authenticator app if they use one; otherwise a 6-digit code emailed to them, saying exactly what it confirms. Valid 5 minutes, used once. A refused action (not enough money, account busy) releases it so the same request can be retried with the same code. |
| Lockout | 5 wrong codes in 15 minutes: no money out for an hour, and an email. 30 emailed codes per 15 minutes. |
| Limits | Up to 3 settlement accounts (active and waiting). Numbers live in `backend/src/config/security.ts`. |

## 3. API (business)

All under `/api`, approved business. Errors are `{ error, code, details? }`. Holds and freezes answer **423**.

### Step-up

`POST /security/step-up` `{ action, request }` → 201 `{ challengeId, method: "totp" | "email", summary, expiresAt }`

`request` is the JSON body the action will be sent with, plus `id` for actions on one item:

| `action` | `request` | Then send |
| --- | --- | --- |
| `transfer.create` | the `POST /transfers` body (skip for `recipient.type: "branch"`) | `POST /transfers` |
| `transfer.bulk` | the `POST /transfers/bulk` body | `POST /transfers/bulk` |
| `transfer.approve` | `{ id }` | `POST /transfers/:id/approve` |
| `batch.approve` | `{ id }` | `POST /transfers/batches/:id/approve` |
| `payout_list.run` | `{ id, branch?, items? }` | `POST /payout-lists/:id/run` |
| `settlement.add` | `{ accountNumber, bankUuid }` | `POST /settlement-accounts` |
| `settlement.remove` | `{ id }` | `DELETE /settlement-accounts/:id` |
| `settlement.withdraw` | `{ id, branch, amountKobo }` | `POST /settlement-accounts/:id/withdraw` |
| `settlement_only.enable` | `{}` | `POST /security/settlement-only` |
| `settlement_only.disable` | `{}` | `POST /security/settlement-only/removal` |
| `money_out.unfreeze` | `{}` | `POST /security/unfreeze` |

Send the action with headers **`X-Step-Up-Id: <challengeId>`** and **`X-Step-Up-Code: <6 digits>`**.

Flow for clients: on the confirm button, start the step-up, show `summary` and a 6-digit field ("Enter the code from your authenticator app" or "We emailed a code to …"), then send the action with the headers. Keep the challenge for retries of the same request; start a new one if the details change. "Send a new code" starts a new step-up.

Codes: `STEP_UP_REQUIRED` (403, `details.action`), `INVALID_CODE` (400, `details.attemptsLeft`), `STEP_UP_EXPIRED` (400), `STEP_UP_USED` (409), `STEP_UP_MISMATCH` (400: details changed), `STEP_UP_LIMIT` (429, `details.retryAt`), `STEP_UP_LOCKED` (423, `details.until`), `INVALID_STEP_UP` (400).

### Protection state

`GET /security` (`accounts.view`):

```jsonc
{
  "moneyOut": {
    "frozen": null | { "at", "source": "member" | "report" | "staff", "byName", "reason", "canUnfreeze" },   // canUnfreeze: a member's freeze, settlement.manage, and no personal hold
    "settlementOnly": { "enabled", "since", "removal": null | { "_id", "kind", "status": "pending" | "approved", "availableAt", "createdAt", "note" } }
  },
  "me": {
    "stepUpMethod": "totp" | "email",
    "twoFactor": { "enabled", "method" },
    "hold": null | { "until": "<date>" | null, "reason": "two_factor_changed" | "reported" },
    "lockedUntil": null | "<date>",
    "memberHoldUntil": null | "<date>",
    "blocker": null | { "code", "message", "until" },        // the first thing stopping this member moving money
    "personalBlocker": null | { "code", "message", "until" }  // a hold on this person alone (ignores a freeze)
  },
  "rules": { "settlementCoolingOffHours": 24, "settlementOnlyOffHours": 72, "maxSettlementAccounts": 3, "twoFactorHoldHours": 24, "newMemberHoldHours": 24 }
}
```

- `POST /security/freeze` `{ reason? }` (`security.freeze`) → 204. Cancels open settlement changes; approved transfers not yet sent are held.
- `POST /security/unfreeze` (`settlement.manage`, step-up) → 204. `UNFREEZE_NEEDS_SUPPORT` (403) when LinkPay or a report froze it. `NOT_FROZEN` (409).
- `POST /security/settlement-only` (`settlement.manage`, step-up) → 204.
- `POST /security/settlement-only/removal` (`settlement.manage`, step-up) → 201 request. `SETTLEMENT_ONLY_OFF` (409, it isn't on), `REQUEST_EXISTS` (409).
- `DELETE /security/settlement-only/removal` (`settlement.manage`) → 204. `REQUEST_NOT_FOUND`.
- `GET /security/events?before=&take=` (`team.manage`) → `{ items: [{ _id, type, summary, actor: { type, name }, ip, createdAt }], nextBefore }`.

Money-out codes on every send, approve and withdraw: `MONEY_OUT_FROZEN`, `SECURITY_HOLD`, `STEP_UP_LOCKED`, `NEW_MEMBER_HOLD` (all 423, `details.until` or null), `SETTLEMENT_ONLY` (403).

### Settlement accounts

- `GET /settlement-accounts` (`accounts.view`) → `{ items }`, open first then the last 10 that ended. Item:
  `{ _id, accountNumber, accountName, bankName, status: pending | active | rejected | cancelled | removed, nameCheck: { result: match | partial, matchedTo: business | person, matchedName }, addedBy: { _id, name }, createdAt, activatedAt, endedAt, lastWithdrawalAt, review: { status, availableAt, decidedAt, note } }`. `review.note` is LinkPay's reason, only when rejected.
- `POST /settlement-accounts/check` `{ accountNumber, bankUuid }` (`settlement.manage`) → `{ accountNumber, accountName, bankName, nameCheck }`. Codes: `SETTLEMENT_NAME_MISMATCH` (422, `details.accountName`), `SETTLEMENT_OWN_ACCOUNT`, `SETTLEMENT_LINKPAY_ACCOUNT`, `ACCOUNT_NOT_FOUND`, `INVALID_BANK`.
- `POST /settlement-accounts` `{ accountNumber, bankUuid, password }` (`settlement.manage`, step-up) → 201 item. Codes: the check's, plus `TWO_FACTOR_REQUIRED` (403), `INCORRECT_PASSWORD` (401), `SETTLEMENT_EXISTS`, `SETTLEMENT_LIMIT` (409).
- `POST /settlement-accounts/:id/cancel` (`settlement.manage`) → item (pending only; `SETTLEMENT_NOT_PENDING`).
- `DELETE /settlement-accounts/:id` (`settlement.manage`, step-up) → item (`removed`; a pending one is cancelled).
- `POST /settlement-accounts/:id/withdraw` `{ branch, amountKobo, narration? }` (`transfers.create`, step-up, optional `Idempotency-Key`) → 201 transfer (as `GET /transfers/:id`, with `recipient.settlementAccount`). The approval rules apply. Codes: `SETTLEMENT_NOT_ACTIVE` (409), `SETTLEMENT_NAME_CHANGED` (409: the bank now shows another name; the business is flagged), plus the transfer codes.

Transfers now carry `recipient.settlementAccount` (id or null): show those as **Withdrawal to <account name>**.

### "This wasn't me" (public, no sign-in)

Emails link to `WEB_URL/security/report/<token>`.

- `GET /public/security-reports/:token` → `{ subject: settlement_account | settlement_only_off | two_factor, summary, businessName, createdAt, status: open | used | expired }`. Reading changes nothing (email scanners open links).
- `POST /public/security-reports/:token` → `{ status: "reported", businessName }`. 10 an hour per IP. Codes: `REPORT_NOT_FOUND` (404), `REPORT_USED`, `REPORT_EXPIRED` (410).

Confirming: cancels the change (or removes the account / turns the lock back on if it already took effect), signs the person who made it out **everywhere** (web tokens too, via `User.security.sessionsValidAfter`) and holds their money out until staff clear it, freezes the business's money out (source `report`), raises a high `account_security` compliance flag, and notifies staff.

### Notifications

User: `security.settlement_requested`, `security.settlement_active`, `security.settlement_rejected`, `security.settlement_removed`, `security.money_out_frozen`, `security.money_out_unfrozen`, `security.protection_changed`, `security.two_factor_changed`. Links point at `/settings/money-protection` (two-step change: `/settings`). Staff: `security.review_requested` (link `/security-reviews/<requestId>`), `security.reported`.

## 4. API (staff, admin/)

Permission `security.review` (super admin, compliance reviewer).

- `GET /admin/security/summary` → `{ pending, coolingOff, frozen, reports30d }`.
- `GET /admin/security/requests?status=pending|approved|completed|rejected|cancelled|open&kind=settlement_account|settlement_only_off&business=&skip=&take=` → `{ items, total, skip, take }` (waiting ones oldest first). Item: `{ _id, kind, status, business: { _id, name, type, frozen }, settlementAccount, requestedBy: { _id, name, email }, ip, userAgent, availableAt, createdAt, completedAt, signals, review, cancellation }`. `signals`: `{ risk: low | medium | high, reasons[], nameCheck (with score and note), requester { name, email, role, memberSince, twoFactor, lastSignInAt, lastSignInIp }, ip, twoFactorChangedAt, failedCodes7d, newDevices7d, settlementChanges30d, activeSettlementAccounts, firstEver, paidBefore, sharedWith[{ _id, name }] }`.
- `GET /admin/security/requests/:id` → the item plus `contacts: { businessEmail, businessPhone, people: [{ fullName, roles, phone, email }] }` (the numbers to call back on), `settlementAccounts[]`, `events[]`.
- `POST /admin/security/requests/:id/approve` `{ note, callbackConfirmed: true }` → item (takes effect at `availableAt`). `CALLBACK_REQUIRED` (400), `REQUEST_NOT_PENDING` (409).
- `POST /admin/security/requests/:id/reject` `{ note }` → item. The note is shown to the business.
- `GET /admin/businesses/:id/security` → `{ moneyOut, settlementAccounts, requests, events }`.
- `POST /admin/businesses/:id/money-out/freeze` `{ reason }`, `/unfreeze` `{ note }` → 204 (lifts any freeze).
- `POST /admin/users/:id/security/clear-hold` `{ note }` → 204 (after a report, or a code lockout).

Audit actions: `security.request_approved`, `security.request_rejected`, `money_out.frozen`, `money_out.unfrozen`, `user.hold_cleared`. New flag category `account_security`.

## 5. Client work

**Web** (`web/`): a step-up dialog used by every money-out button (new transfer, bulk, approve, batch approve, withdraw, settlement changes); **Settings → Money protection** (`/settings/money-protection`): settlement accounts (add with check, password and code; cancel; remove; status with "usable from"), Withdraw, "Settlement accounts only", Freeze / Unfreeze, the member's own hold, security activity; a banner when frozen or on hold; the public `/security/report/[token]` page (preview, then "Yes, stop it"); copy for the new codes.

**admin/**: Security reviews queue (`/security-reviews`, tabs Waiting / Cooling off / Done) and detail (signals with the risk reasons, contacts to call, approve with the call-back tick, reject with a reason), a Security panel on a business (freeze, unfreeze, accounts, activity), clear hold on a user.

**Mobile**: transfers and approvals now need the step-up (`STEP_UP_REQUIRED` until built). Show the same code sheet (the app's passcode or Face ID doesn't replace it: the server must see the second factor). Freeze button, and the hold and frozen states. Adding settlement accounts can stay web-only at first.

## 6. Not built / to decide

- A user can't change or reset their password yet; after a "This wasn't me" report the person is signed out and held, and staff must help them in. Password reset should come next.
- The web's 7-day token is now revocable through `sessionsValidAfter` (one database read per request), but it still isn't a refresh-token session.
- Mobile could later sign step-ups with the device's biometric key instead of a code (FIDO-style transaction confirmation).
- Daily withdrawal or transfer limits per business, and a lower limit for the first payment to a new beneficiary.
- Should LinkPay staff need a second staff approval for high-risk requests (four eyes)?
