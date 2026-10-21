# Mobile notifications: brief

Status: planned 2026-10-21, waiting for the notifications backend (being built in another session; files under `backend/src/**/notification*`, `services/push.ts`, `models/PushToken.ts`). Start once that backend is finished and tested.

## Decisions (product owner, 2026-10-21)

| Question | Decision |
| --- | --- |
| What a push shows on the lock screen | Full details, as the backend writes them ("You received ₦85,000.00 from Bola Stores.") |
| Per-type on/off switches in the app | Not at launch. Everything is on; people mute the app in phone settings. Android gets separate channels so each kind can be muted there |
| How the open app picks up new ones | Refresh on events: on open, when a push arrives, on return to the app, and every 30 s while open. No live stream on mobile |

## Backend contract it builds on

- `GET /api/notifications?business=&unread=true&before=<id>&take=` → `{ items, nextBefore }`, newest first. Item: `{ _id, type, title, body, link, business: { _id, name } | null, data, readAt, createdAt }`. Covers every business the user belongs to.
- `GET /api/notifications/unread-count` → `{ total, byBusiness: { [businessId]: n } }`.
- `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` `{ business? }`.
- `POST /api/notifications/push-tokens` `{ token, platform }` (Expo token; tied to the device session), `DELETE /api/notifications/push-tokens` `{ token }`.
- Push `data`: `{ notificationId, type, businessId, link, ...ids }`. `link` is a **web** path; mobile routes from `type` + ids, never from `link`.
- Types: `backend/src/config/notifications.ts` (`push: true` ones also go to phones).

## What to build

1. **API layer** `lib/api/notifications.ts`: infinite list (cursor `before`), unread count (refetch every 30 s while focused and on app foreground), mark read, mark all read. Query key not scoped to the business in the switcher (the list spans businesses).
2. **Bell on Home**: in the fixed top row, between the LinkPay logo and the business pill, with the unread total as a badge. Opens `(home)/notifications`.
3. **Notifications screen** `(home)/notifications.tsx`: day sections, unread dot, business name on items from another business, "Mark all read" in the header, empty state. Tapping marks it read and opens the target.
4. **Router** `lib/notification-routes.ts`: `type` + `data` → mobile screen. If `businessId` isn't the business in the switcher, switch first (`useBusinessContext.setBusinessId`), then navigate.
   - `transfer.*`: one id → `/payments/transfer/[id]`; a batch → `/payments?view=transfers` (bulk is web-only)
   - `payment.received` → `/payments/[id]` (`transactionId`)
   - `invoice.*` → `/invoices/[id]` (`invoiceId`)
   - `kyb.*` → `/onboarding`; `account.ready` → Home
   - `team.member_joined` → `/team`; `team.role_changed` → Home; `team.removed` → Home (switch away)
   - `security.new_sign_in` → `/more/devices`
5. **Push** (native module, needs a rebuild): `bunx expo install expo-notifications`, config plugin in `app.json` (icon, colour, Android channels: Payments, Transfers, Invoices, Account and security; map each type to a channel on the backend's message `channelId`, a small backend addition).
   - Ask permission once, after passcode/biometrics setup, with our own screen first explaining what they'll get. Never at launch. Respect a refusal; More shows the status and a link to Settings.
   - Register the token after sign-in and each unlock when it changed; remove it **before** sign-out (while the session is still valid). "Sign out and forget" and remote sign-out are covered by the backend dropping tokens of ended sessions.
   - Foreground: `setNotificationHandler` shows the system banner and refetches the list and count.
   - Tap: `addNotificationResponseReceivedListener` + `getLastNotificationResponseAsync` (cold start). If the app is locked, hold the target (like `lib/pending-invite.ts`) and open it after unlock. Mark the notification read.
   - App icon badge: set to the unread total after each count refetch; clear on sign-out.
6. **More**: a "Notifications" row showing the permission status (On / Off, open Settings).
7. **Copy and look**: sentence case, no exclamation marks; rows use the existing list style; icons per type family.

## Needed from the product owner before push works

- An Expo account and EAS project: `bunx eas-cli init` in `mobile/` adds `extra.eas.projectId` to `app.json` (needed for Expo push tokens).
- Real bundle id / package (open question #7): push credentials are tied to it.
- iOS: an Apple Developer account and an APNs key, uploaded through `eas credentials`.
- Android: a Firebase project with FCM, its `google-services.json`, and the FCM key uploaded to Expo.
- Backend: `PUSH_PROVIDER=expo` and `EXPO_ACCESS_TOKEN` (optional, enables push security) in the deployed env.

The in-app list, bell and routing work without any of these; only the phone push needs them.
