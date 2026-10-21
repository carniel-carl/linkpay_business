# LinkPay Business: staff console

The console LinkPay staff use to review business verification (KYB) and fix bank account setup. It is its own app with its own staff accounts: staff can't sign in to the business web or mobile apps, and business users can't sign in here.

```bash
bun install
bun dev          # http://localhost:3001
```

`.env.local` sets `API_URL` (default `http://localhost:4000`). The browser never calls the backend directly; every call goes through server actions and route handlers (`src/lib/api/client.ts`) with the staff token from the httpOnly `lp_staff_session` cookie.

For local work, run the backend on the mock (`cd backend && bun run dev:mock --seed`) and sign in as `staff@linkpay.test` / `password123`. Two-step is always on; the email code prints in the backend console.

Staff accounts are managed from the backend: `bun run staff add <email> "<name>"`, `disable`, `enable`, `list`, `sign-out`.

## Routes

| Path | What it is |
| --- | --- |
| `/sign-in`, `/sign-in/two-factor` | Password, then a code from email or an authenticator app |
| `/` | Review queue (submitted businesses, oldest first) |
| `/businesses` | Every business, with status tabs, search, sort and columns |
| `/businesses/[id]` | One business: checklist, details, people, documents, review actions, account setup |
| `/security` | Change password, switch two-step between email and an authenticator app |
| `/api/files/[businessId]/[documentId]` | Streams a verification document from the backend |
