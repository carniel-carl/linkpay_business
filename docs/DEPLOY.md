# LinkPay Business: production deploy runbook

One ordered checklist for the **first production deploy** of everything in audit batches 1–10 (`fix/audit-batch-10` and later). It replaces the "Before deploying" lists scattered through the session log in [IMPLEMENTATION.md](IMPLEMENTATION.md) §8 (batches 3–7). Work through it top to bottom; tick each box.

`bun run preflight` (`backend/scripts/preflight.ts`) checks most of it **without writing anything**: environment, email provider, the database's data and indexes, and optionally the Liquifia key. Run it before and after the deploy. It prints PASS / WARN / FAIL per check and exits 1 on any FAIL.

```bash
cd backend
bun --env-file=/path/to/production.env scripts/preflight.ts            # --env-file keeps backend/.env out of it
bun --env-file=/path/to/production.env scripts/preflight.ts --liquifia # plus a read-only GET /me and GET /banks
bun --env-file=/path/to/production.env scripts/preflight.ts --liquifia --email --storage # plus Resend's domains and a one-key bucket list
bun run preflight                                                       # on a host whose environment is production's
```

Last updated: 2026-10-25

---

## 1. Prerequisites

- [ ] **One backend instance.** Decided in batch 6. The SSE notification bus, the payment-link live stream, the bank/fee/name caches and the job single-flight guards live in the process. A brief overlap during a restart is safe (every job's writes are conditional), but don't keep two running and don't autoscale.
- [ ] **MongoDB.** A replica set isn't required: nothing uses transactions or change streams. Atlas is fine. Tests run against MongoDB 8.2. The database user needs `readWrite` on the database (it covers `createIndex` and `dropIndex`).
- [ ] **bun 1.4 or later** in every package (the lockfiles need it; `packageManager: bun@1.4.0`).
- [ ] **Email through Resend** (chosen in batch 9; open question 5). In Resend, add the sending domain, publish its DNS records until it shows as verified, and create a **sending-only** API key. Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM` on that domain (§2). With `NODE_ENV=production`, or any live key, the server refuses to start on console email, which would print sign-in codes and invite links to the log. `src/services/providers.ts` wires the provider when it's imported (by `index.ts`, preflight and the scripts that need it). Preflight `--email` checks the key and that the from domain is verified.
- [ ] **File storage.** Uploads (KYB documents, logos, link pictures) go to one of:
  - **An S3-compatible bucket** (`STORAGE_PROVIDER=s3`: AWS S3, Cloudflare R2, DigitalOcean Spaces). Block all public access on the bucket: the API serves every file itself. The key needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`, plus `s3:ListBucket` (preflight `--storage` lists one key, and without it S3 answers a missing file with 403 instead of 404). Turn on versioning or backups for the bucket. **Existing local uploads aren't copied for you:** before switching, sync `UPLOAD_DIR` to `s3://<bucket>/<S3_PREFIX>` keeping the same keys (e.g. `aws s3 sync`).
  - **Local disk** (`STORAGE_PROVIDER=local`, the default) at `UPLOAD_DIR`: an absolute path on a persistent volume, included in the backups. Fine for the single instance.
- [ ] **HTTPS in front of the API, web and admin.** The proxy in front of web and admin must send `X-Forwarded-Proto: https` (for the CSP's `upgrade-insecure-requests`) and set the visitor-IP header named by `CLIENT_IP_HEADER`. Don't cache web or admin pages on a CDN: they're rendered per request with a CSP nonce.
- [ ] **Liquifia:** a live secret key (`sk_live_`). The webhook secret if Liquifia has sent it (open question 1).
- [ ] **Mobile:** an EAS project, the real bundle id (open question 7), and APNs/FCM credentials for `PUSH_PROVIDER=expo`. Slice 3 added native modules, so this is a native build, not an OTA update.

---

## 2. Environment

Values are on only when exactly `1` (`ENCRYPTION_REQUIRE_V2`, `LIQUIFIA_ALLOW_LIVE`, `CSP_REPORT_ONLY`). Numbers are plain digits, and the backend refuses to start on anything else (`60_000`, `30d`) or on a number out of range. Generate secrets with `openssl rand -hex 32`. `backend/.env.example` and `mobile/.env.example` list every variable with a placeholder (copy them to `backend/.env` and `mobile/.env.local` for local work); the tables below say what production needs.

### Backend (`backend/`)

| Var | Production value | Notes |
| --- | --- | --- |
| `NODE_ENV` | **`production`**, set explicitly | Required: the backend refuses to start when it's unset or isn't `production`, `development` or `test`. `bun run start` doesn't set it. `development` refuses a live key unless `LIQUIFIA_ALLOW_LIVE=1`; `test` turns rate limits off, skips the secret checks and refuses a live key outright. |
| `PORT` | default `4000` | 1 to 65535. |
| `MONGODB_URI` | Atlas `mongodb+srv://` URI | Credentials can go in the next two instead of the URI. |
| `MONGODB_DB_NAME` | the database that holds the data | Default `linkpay_business`. Preflight's Data line shows what's in it. |
| `MONGODB_USERNAME`, `MONGODB_PASSWORD` | optional | Passed to the driver separately, so the password needs no URL encoding. |
| `JWT_SECRET` | 32+ random characters | The backend refuses to start on a shorter one, one equal to `ENCRYPTION_KEY`, or, in production or with a live key, a value committed in this repo (`REPO_SECRETS` in `src/config/env.ts`: the `dev:mock` and test secrets). Changing it signs everyone out. |
| `STAFF_JWT_SECRET` | 32+ random characters, different from `JWT_SECRET` | The same rules as `JWT_SECRET`, and it must differ from it. |
| `ENCRYPTION_KEY` | 64 hex characters: **the key the stored BVNs were written with** | Never change it. There's no key rotation, and BVNs written with another key can't be read. Preflight decrypts a sample to prove it's the right one. |
| `ENCRYPTION_REQUIRE_V2` | unset at first, `1` after §5 step 4 | `1` refuses BVNs in the old format. |
| `LIQUIFIA_SECRET_KEY` | `sk_live_…` | |
| `LIQUIFIA_ALLOW_LIVE` | **never set** | A development escape hatch for live keys outside production. |
| `LIQUIFIA_BASE_URL` | unset | Default `https://fiat-api.pouchfinance.xyz/api/v1`. |
| `LIQUIFIA_PUBLIC_KEY` | optional | Read into the config, but no code uses it. |
| `LIQUIFIA_WEBHOOK_SECRET` | from Liquifia | Until it's set, `POST /api/webhooks/liquifia` answers 503: payments arrive through the sync and payout outcomes through the follow-up, both every minute. |
| `LIQUIFIA_SYNC_INTERVAL_MS` | unset (`60000`) | `0`, or 1000 to 86400000. `0` turns off **both** the inbound sync and the payout sender and follow-up, so never `0` in production. |
| `TRUST_PROXY` | the web and admin servers' addresses as the API sees them, plus any load balancer in front of the API, comma-separated | Never `true`, a hop count, or a `/0` range: the server refuses the first two, and all three let a caller choose their own IP. Unset means `loopback`. Web on a host without fixed outgoing IPs (e.g. Vercel) can't be listed yet. |
| `API_URL` | the API's public `https://` origin | Shown to businesses in payment-link embed code and its verify URL. |
| `WEB_URL` | the web app's `https://` origin | Emailed links: invites, invoices, password resets, pay pages, `embed.js`. |
| `ADMIN_APP_URL` | the admin console's `https://` origin, not `WEB_URL` | Staff invite links. |
| `PUSH_PROVIDER` | **`expo`** | Anything else prints every push, text included, to the log. |
| `EXPO_ACCESS_TOKEN` | if the Expo project has enhanced push security | |
| `EMAIL_PROVIDER` | **`resend`** | `console` (the default) prints emails to the log and is refused in production. Anything else stops the boot. |
| `RESEND_API_KEY` | a sending-only key, `re_…` | Required with `resend`. |
| `EMAIL_FROM` | e.g. `LinkPay Business <no-reply@mail.linkpay.ng>` | Required with `resend`, on the domain verified in Resend. A bare address or `Name <address>`; quote a name with punctuation. Preflight FAILs a placeholder domain or `resend.dev`. |
| `EMAIL_REPLY_TO` | optional | Where replies go when an email doesn't say (invoice emails reply to the business). |
| `STORAGE_PROVIDER` | `s3`, or `local` | §1. |
| `S3_BUCKET`, `S3_REGION` | the bucket, and its region (`auto` for R2) | Required with `s3`. |
| `S3_ENDPOINT` | only for R2, Spaces and other non-AWS services | The bare `https://` origin, without the bucket or a path. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the bucket key (§1 for its permissions) | Required with `s3`. |
| `S3_PREFIX` | optional, e.g. `linkpay/production` | A folder inside the bucket. |
| `UPLOAD_DIR` | an absolute path on a persistent volume | Only with `STORAGE_PROVIDER=local`. |
| `MIN_MOBILE_APP_VERSION` | **unset at first**; the new mobile build's version once it can be downloaded | §4 step 3. Three whole numbers (`1.1.0`); the backend refuses to start on anything else. Unset means no minimum. |
| `APP_NAME` | e.g. `LinkPay Business` | Default `LinkPay`, used in every email subject and body. |
| `JWT_EXPIRES_IN` | default `7d` | A web session's maximum age. A duration with a unit (`7d`, `12h`); the backend refuses to start on anything else, bare digits included. |
| `ACCESS_TOKEN_TTL` | default `15m` | Mobile access token. A duration, as above. |
| `SESSION_IDLE_DAYS`, `SESSION_MAX_AGE_DAYS` | defaults `30`, `90` | Mobile device sessions. Idle 1 to 365, max age 1 to 730. |
| `BIOMETRIC_IDLE_DAYS`, `BIOMETRIC_MAX_AGE_DAYS` | defaults `60`, `180` | Biometric sign-in keys. The same ranges. |

These are fixed in code, not env vars: the web session idle timeout is 12 hours (`WEB_SESSION_IDLE_MS` in `src/services/sessions.ts`), and the staff session idle timeout is 60 minutes (`STAFF_SESSION_IDLE_MS`).

### Web (`web/`) and admin (`admin/`)

Set these for `next build` as well as at runtime: `NEXT_PUBLIC_*` values are built into the page. `next start` sets `NODE_ENV=production`, which makes cookies `Secure`.

| Var | App | Production value | Notes |
| --- | --- | --- | --- |
| `API_URL` | both | the backend as **this server** reaches it | It can be a private address. The browser never calls the API. Not the same meaning as the backend's `API_URL`. |
| `CLIENT_IP_HEADER` | both | the header your platform sets with the visitor's IP | `x-real-ip` (nginx, Vercel), `cf-connecting-ip` (Cloudflare). Unset, every visitor shares the server's rate limits (sign-in, pay pages, and public files: invoice PDFs, logos, link pictures), and production logs `CLIENT_IP_HEADER isn't set`. The check of which sites may embed a payment link is asked as the web server itself (remembered for 30 seconds per link) and as the visitor only when the server's own limit is spent. |
| `CSP_REPORT_ONLY` | both | `1` for the first days, then unset | See §5 step 5. |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | web | the real support address | Default `support@linkpay.ng` (placeholder, open question 7). |

The admin's `start` script is fixed to port 3001.

### Mobile (`mobile/`, EAS build)

| Var | Production value | Notes |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | the API's public `https://` origin | A release build refuses anything that isn't https. Bundled in plain text. |
| `EXPO_PUBLIC_SUPPORT_EMAIL` | the real support address | |
| `EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE` | unset | Development only. |
| `EXPO_PUBLIC_IOS_STORE_URL` | `https://apps.apple.com/app/id<app id>` | Where the "Update LinkPay" screen sends iPhones. Without it the screen only says to open the App Store. |
| `EXPO_PUBLIC_ANDROID_STORE_URL` | unset, unless the Play listing isn't the app's package | Defaults to the Play listing for the app's package. |

---

## 3. Before the new backend starts

Run the scripts from the **new** release's `backend/`, with the production environment (`--env-file`, as above). They load `src/config/env.ts`, so they need `NODE_ENV=production` for the live key, never `LIQUIFIA_ALLOW_LIVE`.

1. [ ] **Back up.** Take an Atlas on-demand snapshot (or `mongodump`) of the whole database, and copy `UPLOAD_DIR` or the bucket (or check its versioning is on). Note the time. After `migrate:kyb --apply`, `migrate:staff --apply` and `migrate:encryption --apply`, this backup is the only way back.
2. [ ] **Preflight** with `--liquifia --email --storage`. Fix every FAIL in Environment and Email and files. Expect these Database lines at this point: KYB documents (FAIL until step 4), Encrypted BVNs and TOTP secrets (WARN until §5), Unique indexes (WARN until the backend builds them), and maybe Staff (step 3).
3. [ ] **`migrate:staff`**, only if preflight's Staff line names `role "admin"` users or staff without a role. Run `bun run migrate:staff`, read the dry run, then run `bun run migrate:staff --apply` **with the product owner's go-ahead** (open question 11). It deletes users who were staff only, with their sessions and biometric keys. IMPLEMENTATION.md disagrees with itself here: the 2026-10-21 session log says the product owner ran it on Atlas, but its §3 status table and open question 11 say it hasn't been run. The Staff line settles it. If the line says no super admin is active, add one: `bun run staff add <email> "<name>"`.
4. [ ] **`migrate:kyb`** removes duplicate KYB documents, so the unique `{ business, type, person }` index can build. Run `bun run migrate:kyb` (dry run) whenever you like. Run `bun run migrate:kyb --apply` in the deploy window, after the old backend is stopped and **before the new backend starts**: two uploads at once on the old code can still make a duplicate. It deletes the extra documents and their files through `src/services/storage.ts`. It loads the storage wiring (`src/services/providers.ts`), so with `STORAGE_PROVIDER=s3` it deletes from the bucket.
5. [ ] **Preflight again.** No FAIL is left.

The dry runs are read-only: the scripts connect with Mongoose's autoIndex and autoCreate off, so they build no index and create no collection. Only `--apply` runs `syncIndexes` (`migrate:staff` on `staff`, `migrate:kyb` on `kybdocuments`). `migrate:branches` has no dry run (§5 step 9). Preflight never writes.

---

## 4. Deploy order

1. [ ] **Backend.** Stop the old one, then start the new one, still a single instance. The startup log says `Encryption: values in the old format (before v2) are still read…`, `Email: Resend, from <EMAIL_FROM>. Files: <the bucket, or local disk at UPLOAD_DIR>.`, then `Server running on…`. Around the same time it logs `Indexes: every declared index is built (N models)`, or `🚨 INDEX BUILD FAILED` with one line per missing index (§5 step 1). If it won't start, the error names the variable: `NODE_ENV` unset or unknown; a secret too short, shared or from the repo; a number, duration or `MIN_MOBILE_APP_VERSION` that isn't one; `TRUST_PROXY`; `ENCRYPTION_KEY`; the console email provider in production; or a live key without `NODE_ENV=production`. Preflight's Startup modules and Backend config lines show the same errors.
   - **Sessions:** from this moment the API refuses web tokens without a `sid`, so **every web user is signed out**, whichever web version they're on. Mobile device sessions already carry one and stay signed in.
   - **PIN:** the 15 covered routes (sending, approving, savings moves, security settings) answer `TRANSACTION_PIN_REQUIRED` until the user sets a PIN. The old web and old mobile builds have no way to set one.
   - **2FA sign-ins in progress:** two-step challenges now carry the password stamp. A challenge issued by the old backend (they last 10 minutes) is refused for anyone whose password has ever changed, so they sign in again.
   - **Batch decisions** need `expect` (400 `EXPECT_REQUIRED`). Web and mobile from batch 8 on send it.
   - **Idempotency keys:** `POST /api/transfers`, `/api/transfers/bulk` and `/api/payout-lists/:id/run` answer 400 `IDEMPOTENCY_KEY_REQUIRED` without an `Idempotency-Key` header. The new web and mobile send one. Anything else that sends money through the API (a script, an integration) must too.
2. [ ] **Admin and web together, straight after.** They can't go first, because they call endpoints only the new backend has: `/api/transaction-pin`, `/api/auth/password`, `GET /transfers/batches`, `bulk/preview`, `resolve-accounts`, and the `decided`/`skipped` batch answers. They can't wait either: until the new web is live, nobody on the web can send or approve money, because only it can set a PIN. Admin and the backend share the new `activity.view_ips` permission and the audit labels (`staff.added`; a contract test keeps the two lists in step). Set `CLIENT_IP_HEADER` before they go live, or sign-in limits count every visitor as the web server.
3. [ ] **Mobile forced update.** Old builds can't send `X-Transaction-Pin` or set a PIN, so every money action fails on them. They also predate the batch summary list. Release the new build (App Store, Play, TestFlight) with a higher `version` in `mobile/app.json`, built with `EXPO_PUBLIC_IOS_STORE_URL` (`https://apps.apple.com/app/id<app id>`; without it the iOS update screen has no store button) and, if the Play listing isn't the app's package, `EXPO_PUBLIC_ANDROID_STORE_URL`. **Once it can be downloaded**, set `MIN_MOBILE_APP_VERSION` on the backend to that version (three whole numbers, like `1.1.0`; anything else stops the boot) and restart it. Set it earlier and phones are told to update to a version they can't get yet.
   - From then on the API answers `426` with code `APP_UPDATE_REQUIRED` to a phone on an older version, or one that doesn't send `X-App-Version`, which is every build before this one: its signed-in requests and its sign-ins. Only signing out, refreshing the session and removing a push token still work, so updating keeps the phone signed in.
   - Old builds show the error's message ("Update the LinkPay app to keep using it."). New builds cover the app with an "Update LinkPay" screen that links to the store, as soon as `GET /api/app/version` (asked at launch) or any refused request says they're too old.
   - Web and staff are never affected. Unset means no minimum. To let phones back in, lower or unset it and restart: a new build showing the update screen asks again each time it comes back to the foreground.
   - `sessions.device.appVersion` shows the version each phone signed in with. It doesn't change when the app is updated.
   - If no build is in users' hands yet, publish the first one only after the backend is live, and set the minimum to its version.
   - Never release the new build before step 1: it needs the new backend's endpoints (the transfers list's `?batch=none`, for one, is a 400 on the old backend).

---

## 5. After deploy

1. [ ] **Indexes built.** Mongoose builds missing indexes at startup and drops a failed build's error, so the backend now waits for the builds and reports them itself: the startup log line from §4 step 1, and `indexes` in `GET /health` (`pending`, `ok` or `failed`). A failed unique index means those duplicates aren't being refused. Check:
   - `GET /health` says `"indexes": "ok"`.
   - Re-run preflight. The Unique indexes WARN must be gone, and the Indexes line must say `all in place`. A FAIL names the collection and key that duplicates block. Remove the duplicates, then restart the backend, which retries the build.
   - Spot-check the collections batches 3–8 changed with `db.<collection>.getIndexes()` in mongosh: `kybdocuments`, `transfers` (batch 8 adds `{ business, recipient.accountNumber, createdAt }`), `transferbatches`, `ratelimithits`, `pocketmovements`, `virtualaccounts`, `checkouts` (batch 8 adds a partial `{ virtualAccount, amountKobo, createdAt }` on pending checkouts).
   - Don't reach for `syncIndexes`. Besides building what's missing, it **drops every index no schema declares**, which is broader than the two drops below.
2. [ ] **Drop the two replaced indexes** once preflight's Old index lines say their replacements are built. Both drops are safe.
   ```js
   db.transfers.dropIndex("batch_1")          // replaced by { batch: 1, status: 1 }
   db.transferbatches.dropIndex("business_1") // replaced by { business: 1, createdAt: -1 }
   ```
3. [ ] **Rate limits** now live in MongoDB (`ratelimithits`). They start from zero at this deploy, and each limited request costs one Mongo write.
4. [ ] **`migrate:encryption`.** Run `bun run migrate:encryption` (dry run). If it lists unreadable values, stop: `ENCRYPTION_KEY` isn't the data's key. Then run `bun run migrate:encryption --apply`, and run it again until it prints `No values left in the old format`. Since batch 9 it also encrypts authenticator-app (TOTP) secrets, which were stored in plain text; that last line covers BVNs and TOTP secrets together, and preflight's TOTP secrets line must be PASS too. Set `ENCRYPTION_REQUIRE_V2=1`, restart the backend, and check that the startup log says old-format values are refused and preflight's Encrypted BVNs line is PASS. **This is the point of no return for the backend** (§8).
5. [ ] **CSP rollout.** Deploy web and admin with `CSP_REPORT_ONLY=1` for the first days, and watch their `/api/csp-report` log lines (`CSP report-only: <directive> <blocked> on <page>`). Cover sign-in, the dashboard, pay pages and an embedded checkout. When it's quiet, unset `CSP_REPORT_ONLY` and redeploy both. Violations then log as `CSP blocked: …`; keep watching for a few days.
6. [ ] **Alerts.**
   - Backend `Rate limits can't reach MongoDB: requests are NOT being limited until it's back.` Limits fail open while the store is down. The session log calls it "rate limit store unavailable", but that's not the actual text. Recovery logs `Rate limits are counting again: MongoDB is back.`
   - Backend `🚨 INDEX BUILD FAILED`, or `GET /health` with `"indexes": "failed"`.
   - Web and admin `CLIENT_IP_HEADER isn't set`.
   - `transfer.stuck` in the admin bell: payouts in an unknown state, or not settled after a day.
7. [ ] **Liquifia webhook**, once the secret arrives: set `LIQUIFIA_WEBHOOK_SECRET`, restart, and give Liquifia `https://<API host>/api/webhooks/liquifia`. Confirm the signature scheme first (§5 of IMPLEMENTATION.md, open question 1).
8. [ ] **Balance snapshots.** The morning after the deploy, check that every active account has one for today: `db.balancesnapshots.countDocuments({ day: "<today YYYY-MM-DD>" })` against the count of active virtual accounts. The job makes one Liquifia balance call per account per day, retries a failing account every minute for the first 15 minutes and then hourly, and is off when `LIQUIFIA_SYNC_INTERVAL_MS=0`. The collection's unique `{ virtualAccount, day }` index builds at startup like the rest.
9. [ ] Optionally, `bun run migrate:branches`. It's a safety net: the API also creates head offices lazily. It writes, with no dry run.

---

## 6. User-visible effects to announce

- **Every web user signs in again**, once, when the backend goes live. Web sessions now end after 12 hours idle (still to confirm with the product owner, batch 3), and signing out ends them on the server. Staff sign in again too if `STAFF_JWT_SECRET` is new.
- **Transaction PIN.** The first time someone sends, approves, moves savings or changes a security setting, they choose a 4-digit PIN (their password, then the PIN twice), and the action carries on. Anyone without a password (some email-code sign-ups, and anyone whose sign-up password the H1 fix removed) gets `PASSWORD_NOT_SET` and must use "Forgot password" first. Easy PINs (1234, 1111, 2580, years) are refused. Five wrong PINs in a row lock it for 30 minutes; 15 wrong in a day lock it until it's reset, and the user is emailed.
- **Mobile: update the app.** Old versions can't send or approve money.
- **Two-step sign-in recovery codes.** Anyone using an authenticator app gets 10 one-time recovery codes the next time they turn it on, or from Security › Get new codes. Tell existing authenticator users to make theirs: until they do, a lost phone is still a support case.
- **Statements.** Transactions › Download statement (web) and an account's Statement (mobile): PDF or CSV for up to 366 days. Opening and closing balances appear from the deploy day on: the backend records each account's balance, as Liquifia reports it, just after midnight each day.
- **Suspended or closed businesses** now see a banner and read-only screens, or a "closed" page, instead of raw errors.
- Bulk transfers have a review step, and batch approval decides only the rows waiting for you. The approve button names the count and total ("Approve 3 · ₦45,000"), and if the batch changes before the PIN is entered, nothing is approved and the screen refreshes.
- Automatic invoice reminders stop 30 days after the due date, so an invoice already further overdue gets no more when the new backend starts.

---

## 7. First live payout check

Only with the product owner's go-ahead. It's the first real money out (IMPLEMENTATION.md §6, item 1).

1. [ ] From a branch with money, send one **small transfer** (say ₦100, under the ₦10,000 stamp-duty line) to an account you control, from the web, with the PIN.
2. [ ] **Find out when the debit lands.** Write down the account's Liquifia balance (`balance` in `GET /api/accounts`, or the admin Activity tab's live balance) three times: before sending; once the transfer is `processing` and has a payout id (Liquifia accepted it); and after `success`.
3. [ ] **Check the response shape.** The raw payout is kept on the transfer (`provider.data`). The code relies on `id`, `status` and `reference`; amounts in payout responses aren't read.
4. [ ] **Ask Liquifia** (read-only questions, IMPLEMENTATION.md §5): what trace returns for an unknown reference; what `POST /payouts` returns for a key still in progress (the docs say 409) and for one already finished; whether `reference` is unique on their side; the payout webhook's fields; whether a payout can be reversed after `success`; the webhook signature scheme; whether a business customer type exists.
5. [ ] **Relax the holds if the debit lands on acceptance.** Today a transfer's total stays held until it's final (`heldByAccount` in `backend/src/services/transfers.ts` sums every `pending_approval` and `processing` transfer), so while a payout settles, `availableKobo` counts it twice and `GET /api/accounts` clamps it at ₦0. If step 2 shows the balance dropping once Liquifia accepts, stop holding `processing` transfers that have `provider.payoutId`, add a test, and ship it as a normal backend change. If it drops only at `success`, leave it as is.

---

## 8. Rollback

| What | Can it be undone? |
| --- | --- |
| Web and admin | Only together with the backend. The old web on the new backend can't set a PIN, so nobody could send money. |
| Backend code | Yes, until **the first v2 BVN is written**. That's `migrate:encryption --apply`, or anyone saving a BVN on the new backend. Older code can't read v2 values, so it fails on approval and provisioning. Check with `db.businesses.countDocuments({ "people.bvnEncrypted": /^v2:/ })`: while it's 0, a rollback is safe. |
| `ENCRYPTION_REQUIRE_V2=1` | Yes. Unset it and restart. |
| TOTP secrets and recovery codes | Older code can't read an encrypted TOTP secret, and the new backend writes one for anyone who turns on an authenticator app (and `migrate:encryption --apply` writes them all). After a rollback those people can't finish signing in until 2FA is reset for them. Check with `db.users.countDocuments({ "twoFactor.totpSecret": /^v2:/ })` and the same on `db.staff`. Recovery codes are ignored by older code. |
| `EMAIL_PROVIDER`, `STORAGE_PROVIDER` | Older code ignores them: email falls back to console (refused in production) and files to `UPLOAD_DIR`. Files written to the bucket aren't on local disk, so roll back storage only after syncing the bucket back. |
| Index changes | Harmless to older code. If you roll back, recreate the dropped ones for speed: `db.transfers.createIndex({ batch: 1 })` and `db.transferbatches.createIndex({ business: 1 })`. |
| `migrate:kyb --apply`, `migrate:staff --apply` | No. The deleted documents, files, staff-only users and their sessions come back only from the backup. |
| PINs, web sessions, rate-limit counters | Older code ignores them. Leave them in place. |
| Mobile | No. Installed apps can't be rolled back, and the new app needs the new backend's PIN and batch endpoints, so once it's out the backend stays. |
| `MIN_MOBILE_APP_VERSION` | Yes. Lower or unset it and restart. |
| Restoring the backup | A last resort. It loses everything since. Payments in come back through the sync (keyed by Liquifia's id), but **payouts sent since the backup happened at Liquifia and are gone from our records**. Reconcile against Liquifia's payouts before reopening. |

---

## 9. Known gaps

- **API responses are `no-store`** (batch 10). iOS no longer keeps them in its on-disk cache. Responses already cached by a development build stay there until iOS evicts them, which doesn't matter before launch.
- **One instance only** until the per-process pieces listed in the batch 5 session log become shared. Batch 9 adds one: statement PDFs render at most two at a time, queued in the process.
- **Email during a Resend outage.** Each email gets 20 seconds in all, across up to 4 tries with backoff. An awaited send (inviting someone, sending an invoice) fails within about 20 seconds. The limit applies to background sends too, such as sign-in codes, so in an outage where every try times out they get 2 tries.
- **Statement balances start at the deploy day** (`docs/briefs/statements.md`). Earlier periods show none, and say from when balances are recorded.
- **The webhook secret and signature scheme** are still to come from Liquifia, and so are its answers on payouts and inbound transfers.
- The batch 4 list asked to check a `Notification.branch` index. No such index exists, and none is needed (ops re-audit), so it isn't in §5.
