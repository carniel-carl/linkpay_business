import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { markReadById, NOTIFICATIONS_KEY, useUnreadCount } from "@/lib/api/notifications";
import { useAuth } from "@/lib/auth/store";
import { openNotification, type NotificationTarget } from "@/lib/notification-routes";
import { configurePush, loadNotifications, registerPush, setAppBadge, targetFromPush } from "@/lib/push";

type Pending = NotificationTarget & { notificationId?: string };

/** A tapped push waiting for the app to be unlocked. Memory only. */
const usePendingPush = create<{ target?: Pending; set: (target?: Pending) => void }>((set) => ({ target: undefined, set: (target) => set({ target }) }));

// A cold start reports the launching tap, and the listener may report it too: open it once.
const handled = new Set<string>();

/**
 * Wires phone push into the app (mounted once in the root layout): sets pushes up at launch, registers the
 * phone after each unlock, refreshes the list and badge when a push arrives, keeps the app icon badge in step,
 * and opens a tapped push's screen, waiting for the passcode or Face ID first when the app is locked.
 */
export function PushBridge() {
  const qc = useQueryClient();
  const status = useAuth((s) => s.status);
  const unlocked = status === "unlocked";
  const pending = usePendingPush((s) => s.target);
  const unread = useUnreadCount(unlocked).data?.total;

  useEffect(() => {
    let live = true;
    const subs: { remove: () => void }[] = [];
    void (async () => {
      const N = await loadNotifications();
      if (!N || !live) return;
      await configurePush();
      const take = (response: import("expo-notifications").NotificationResponse | null) => {
        if (!response || handled.has(response.notification.request.identifier)) return;
        handled.add(response.notification.request.identifier);
        const target = targetFromPush(response.notification.request.content.data as Record<string, unknown> | undefined);
        if (target) usePendingPush.getState().set(target);
      };
      subs.push(
        N.addNotificationReceivedListener(() => void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY })),
        N.addNotificationResponseReceivedListener(take),
        N.addPushTokenListener(() => {
          if (useAuth.getState().status === "unlocked") void registerPush();
        }),
      );
      take(await N.getLastNotificationResponseAsync());
    })();
    return () => {
      live = false;
      subs.forEach((s) => s.remove());
    };
  }, [qc]);

  // After each unlock: (re)register this phone, so a changed token or a new session is picked up.
  useEffect(() => {
    if (unlocked) void registerPush();
  }, [unlocked]);

  // Open a tapped push once the app is open.
  useEffect(() => {
    if (!unlocked || !pending) return;
    usePendingPush.getState().set(undefined);
    if (pending.notificationId) void markReadById(pending.notificationId).then(() => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }));
    openNotification(pending);
  }, [unlocked, pending, qc]);

  useEffect(() => {
    if (unread !== undefined) void setAppBadge(unread);
  }, [unread]);

  return null;
}
