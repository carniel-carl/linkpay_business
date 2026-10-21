import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { api } from "@/lib/api/client";
import type { NotificationTarget } from "@/lib/notification-routes";

// Phone push (expo-notifications). Contract: docs/briefs/notifications.md §2 and §5; plan and decisions:
// docs/briefs/mobile-notifications.md. Pushes show full details on the lock screen (product owner, 2026-10-21).
//
// expo-notifications is loaded lazily and only when its native side is in the build: a development client
// built before it was added has no ExpoPushTokenManager, and importing the module there would crash.

type NotificationsModule = typeof import("expo-notifications");

let loading: Promise<NotificationsModule | null> | undefined;

/** expo-notifications, or null on a build without it. */
export function loadNotifications() {
  loading ??= (async () => {
    if (!requireOptionalNativeModule("ExpoPushTokenManager")) return null;
    try {
      return await import("expo-notifications");
    } catch {
      return null;
    }
  })();
  return loading;
}

/** Android channels, one per kind, with the ids the backend puts on each push (`channelId`). */
const CHANNELS = [
  { id: "payments", name: "Payments", description: "Money coming into your accounts" },
  { id: "transfers", name: "Transfers", description: "Approvals, and transfers sent or failed" },
  { id: "invoices", name: "Invoices", description: "Invoices paid, part paid or overdue" },
  { id: "account", name: "Account and security", description: "Verification, new accounts, team changes and new sign-ins" },
] as const;

/** Once per launch: how pushes show while the app is open, and the Android channels. */
export async function configurePush() {
  const N = await loadNotifications();
  if (!N) return;
  N.setNotificationHandler({
    // In the foreground too: the banner is how a teller sees a payment land while the app is open.
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  if (Platform.OS === "android") {
    await Promise.all(
      CHANNELS.map((c) =>
        N.setNotificationChannelAsync(c.id, {
          name: c.name,
          description: c.description,
          importance: c.id === "payments" || c.id === "transfers" ? N.AndroidImportance.HIGH : N.AndroidImportance.DEFAULT,
        }).catch(() => null),
      ),
    );
  }
}

export type PushStatus = "unavailable" | "undetermined" | "granted" | "denied";

/** Whether this phone can get pushes from the app: not in this build, not asked yet, on, or turned off. */
export async function pushStatus(): Promise<PushStatus> {
  const N = await loadNotifications();
  if (!N) return "unavailable";
  const p = await N.getPermissionsAsync();
  if (p.granted || p.ios?.status === N.IosAuthorizationStatus.PROVISIONAL) return "granted";
  return p.canAskAgain ? "undetermined" : "denied";
}

/** The system prompt. Only call it after the app has said why (the Home card, or More › Notifications). */
export async function askForPush(): Promise<PushStatus> {
  const N = await loadNotifications();
  if (!N) return "unavailable";
  await N.requestPermissionsAsync();
  const status = await pushStatus();
  if (status === "granted") await registerPush();
  return status;
}

const projectId = () =>
  (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;

let registered: string | undefined;

/**
 * Sends this phone's Expo push token to the backend, tied to the current device session. Called after each
 * unlock (cheap, and catches a token that changed); quiet if permission isn't granted or the app has no EAS
 * project id yet (`bunx eas-cli init`).
 */
export async function registerPush() {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  const N = await loadNotifications();
  if (!N || (await pushStatus()) !== "granted") return;
  const id = projectId();
  if (!id) {
    if (__DEV__) console.warn("Push: no EAS project id in app.json (run `bunx eas-cli init`), so this phone can't get pushes yet.");
    return;
  }
  try {
    const { data: token } = await N.getExpoPushTokenAsync({ projectId: id });
    await api("/api/notifications/push-tokens", { method: "POST", json: { token, platform: Platform.OS } });
    registered = token;
  } catch (err) {
    if (__DEV__) console.warn("Push: couldn't register this phone", err);
  }
}

/** Before signing out, while the session still works: this phone stops getting this account's pushes. */
export async function unregisterPush() {
  const N = await loadNotifications();
  if (!N) return;
  try {
    const token = registered ?? (projectId() ? (await N.getExpoPushTokenAsync({ projectId: projectId()! })).data : undefined);
    if (token) await api("/api/notifications/push-tokens", { method: "DELETE", json: { token } });
  } catch {
    // The backend also drops tokens of sessions that ended, so this is best effort.
  }
  registered = undefined;
  await N.setBadgeCountAsync(0).catch(() => false);
}

/** The app icon badge: the unread total across every business. */
export async function setAppBadge(count: number) {
  const N = await loadNotifications();
  await N?.setBadgeCountAsync(count).catch(() => false);
}

/** A tapped push's `data` as something the app can open. */
export function targetFromPush(data: Record<string, unknown> | undefined): (NotificationTarget & { notificationId?: string }) | undefined {
  if (!data || typeof data.type !== "string") return undefined;
  return {
    type: data.type,
    businessId: typeof data.businessId === "string" ? data.businessId : null,
    data,
    notificationId: typeof data.notificationId === "string" ? data.notificationId : undefined,
  };
}

// ---- The Home card that explains pushes before the system prompt; "Not now" is remembered on the phone ----

const dismissedFile = new File(Paths.document, "push-prompt-dismissed");

export function pushPromptDismissed() {
  try {
    return dismissedFile.exists;
  } catch {
    return true;
  }
}

export function dismissPushPrompt() {
  try {
    if (!dismissedFile.exists) dismissedFile.create();
  } catch {
    // Not saved: the card comes back next launch.
  }
}
