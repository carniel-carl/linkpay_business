# Brief: real-time notifications (web, admin, mobile)

Product owner's request, 2026-10-21: real-time notifications in the web app, the admin console and the mobile app, for every event below.

**Backend: done** (2026-10-21, `tests/notifications.test.ts`). This brief is the contract for the clients:
- web/: being built by session linkpay-business-c7
- admin/: being built by session linkpay-business-e5
- mobile/: being built by session linkpay-business-23; see §5

## 1. How it works

- Every notification is **stored** (MongoDB `notifications`, kept 90 days). The list and the unread count come from the REST endpoints, so nothing is lost while a client is offline.
- **Live updates** come over **Server-Sent Events** (SSE). The stream only announces new notifications and read-state changes. It's one-way, plain HTTP, and reconnects with `Last-Event-ID` to replay anything missed.
- **Phones** also get an **Expo push notification** for the types marked "push" in §4, sent to every phone where the user is still signed in. In development pushes print to the backend console (`📱 Push to ...`). `PUSH_PROVIDER=expo` sends them for real.
- Emails are unchanged. Notifications are in addition to them.
- One backend instance today: live delivery goes through an in-process bus. Running several instances needs a shared bus (Redis pub/sub or MongoDB change streams) via `setNotificationBus()`.

## 2. Business users: `/api/notifications` (Bearer token; no `X-Business-Id`)

A user sees their notifications across all their businesses. Each one names its business.

| Method and path | Body / query | Response |
| --- | --- | --- |
| `GET /` | `?business=<id>&unread=true&before=<id>&take=1..100` (default 20) | `{ items, nextBefore: id \| null }`, newest first. Next page: `before=nextBefore` |
| `GET /unread-count` | | `{ total, byBusiness: { [businessId]: n } }` |
| `POST /:id/read` | | the notification (`404 NOTIFICATION_NOT_FOUND`) |
| `POST /read-all` | `{ business? }` | `{ updated }` |
| `GET /stream` | header `Last-Event-ID` (or `?lastEventId=`) | SSE, see §3 |
| `POST /push-tokens` | `{ token: "ExponentPushToken[...]", platform: "ios" \| "android" }` | `204`. Mobile only, after sign-in and whenever the token changes. Tied to the device session; a phone signing in to another account takes the token over |
| `DELETE /push-tokens` | `{ token }` | `204`. Call before signing out |

**Notification object**

```ts
{
  _id: string;
  type: string;             // §4
  title: string;            // short, e.g. "Money in"
  body: string;             // one sentence, ready to show
  link: string | null;      // path in the web app (users) or admin/ (staff), e.g. "/invoices/<id>"
  business: { _id: string; name: string | null } | null;  // null for account-level ones (security) and for staff
  data: Record<string, unknown>;  // ids for opening the right screen (transferIds, batchId, invoiceId, transactionId, branchId, businessId, staffId, userId)
  readAt: string | null;
  createdAt: string;
}
```

## 3. The stream (SSE)

`GET /api/notifications/stream` (users) or `GET /api/admin/notifications/stream` (staff), with the Bearer token.

- Starts with `retry: 5000`.
- `event: notification`: `data` is the notification object, and the event `id` is its `_id`.
- `event: read`: `data` is `{ ids: [...] }` (one marked read) or `{ all: true, business: id | null }`. Read state changed in another tab or device; update badges and lists.
- `event: ready`: `data` is `{ unread }` (the total). Sent once after connecting and after any replay.
- `event: end`: `data` is `{ reason: "token_expired" | "session_ended" }`, sent just before the server closes the stream. On `token_expired`, reconnect with a fresh token (mobile access tokens last 15 minutes). On `session_ended` (signed out, revoked, staff disabled or idle), stop and send the person to sign in.
- A `: ping` comment every 20 seconds keeps proxies from closing it.
- Reconnecting with `Last-Event-ID: <last notification id>` replays up to 100 missed notifications before `ready`.
- At most 10 open streams per person; the 11th gets `429 TOO_MANY_STREAMS`.
- Through a Next.js route handler (web and admin keep the token in an httpOnly cookie): fetch the backend with the Bearer token, forward `Last-Event-ID`, return the body as a stream unbuffered, with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Abort the backend fetch when the browser disconnects.

## 4. Types

Business users (web and mobile). "Push" = also a phone push.

| Type | Who | Push | Link |
| --- | --- | --- | --- |
| `transfer.approval_requested` | members who can approve transfers from that branch (not the creator) | ✓ | `/transfers?transfer=<id>` or `?batch=<id>` |
| `transfer.approved` | the creator | ✓ | same |
| `transfer.rejected` | the creator (with the note) | ✓ | same |
| `transfer.completed` | the creator, when the bank confirms | ✓ | same |
| `transfer.failed` | the creator | ✓ | same |
| `payment.received` | members who can see that branch's account (`accounts.view`), once per payment when it succeeds | ✓ | `/transactions` |
| `invoice.viewed` | the invoice's creator, the first time the customer opens it | | `/invoices/<id>` |
| `invoice.payment_received` | creator + members with `invoices.manage` for the branch (part payment) | ✓ | `/invoices/<id>` |
| `invoice.paid` | same (paid in full) | ✓ | `/invoices/<id>` |
| `invoice.overdue` | same, once when it passes its due date unpaid (checked 08:00–20:00 Lagos) | ✓ | `/invoices/<id>` |
| `kyb.approved` | the owner | ✓ | `/dashboard` |
| `kyb.changes_requested` | the owner (with the note) | ✓ | `/onboarding` |
| `kyb.rejected` | the owner (with the reason) | ✓ | `/onboarding/status` |
| `account.ready` | members who can see that branch's account | ✓ | `/accounts` |
| `team.member_joined` | members who manage the team | | `/team` |
| `team.role_changed` | the member | ✓ | `/dashboard` |
| `team.removed` | the member | ✓ | none |
| `security.new_sign_in` | the user, when a phone they haven't used before signs in (not their first phone) | ✓ | `/settings/security` |

Staff (admin/), in-app only:

| Type | Who | Link |
| --- | --- | --- |
| `kyb.submitted` | staff with `kyb.review` ("New business to review" or "Business resubmitted") | `/businesses/<id>` |
| `account.setup_failed` | staff with `accounts.provision` | `/businesses/<id>` |
| `staff.invite_accepted` | the staff member who sent the invite | `/staff` |
| `staff.role_changed` | the staff member | `/` |

## 5. Mobile

The mobile session's plan and the product owner's decisions for mobile (full-detail pushes, no per-type switches at launch, refreshing on events instead of a live stream) are in [mobile-notifications.md](mobile-notifications.md); that file wins where the notes below differ.

- After sign-in (and on app start while signed in): ask for notification permission at a sensible moment, get the Expo push token (`expo-notifications`, `getExpoPushTokenAsync({ projectId })`), and `POST /api/notifications/push-tokens`. Before signing out: `DELETE` it.
- Each push carries an Android `channelId`: `payments` (payment.*), `transfers` (transfer.*), `invoices` (invoice.*) or `account` (verification, bank accounts, team, security). Create channels with these ids (`backend/src/config/notifications.ts`, `PUSH_CHANNELS`).
- Tapping a push: `data` holds `notificationId`, `type`, `businessId`, `link` and the ids from §2. Open the matching screen (switch business first if `businessId` differs), and mark it read.
- While the app is open: a notifications screen (list, mark read, mark all read) and a badge from `/unread-count`. React Native has no `EventSource`: use the stream through `expo/fetch` streaming (or `react-native-sse`) while in the foreground, close it in the background, and reconnect on `end: token_expired` after refreshing the token.
- Needs a native rebuild (expo-notifications) and, for real pushes, the Expo project id plus APNs/FCM credentials in EAS. Open question for the product owner.

## Contract changes

(Write any change here, and tell the client sessions.)
