import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "./client";
import { idSegment } from "./paths";
import type { AppNotification, NotificationList, UnreadCount } from "./types";

// /api/notifications: the signed-in person's notifications across every business they belong to, so the
// keys aren't scoped to the business in the switcher (and no X-Business-Id is needed). The open app
// refreshes on launch, on return to the foreground, when a push arrives and every 30 s while it's open
// (product owner's choice, 2026-10-21); there's no live stream on mobile.

export const NOTIFICATIONS_KEY = ["notifications"] as const;
const LIST_KEY = [...NOTIFICATIONS_KEY, "list"] as const;
const COUNT_KEY = [...NOTIFICATIONS_KEY, "unread-count"] as const;

export function useNotifications() {
  return useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ take: "30", ...(pageParam && { before: pageParam }) });
      return api<NotificationList>(`/api/notifications?${params}`, { signal });
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
  });
}

/** The badge. `enabled` is false until the app is signed in and unlocked. */
export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: COUNT_KEY,
    queryFn: () => api<UnreadCount>("/api/notifications/unread-count"),
    enabled,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

/** Pulls the list and badge again, e.g. when a push arrives. */
export const refreshNotifications = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });

type ListData = InfiniteData<NotificationList, string>;

/** Marks read straight away in the list and badge, then tells the server. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (n: Pick<AppNotification, "_id" | "business">) => api<AppNotification>(`/api/notifications/${idSegment(n._id)}/read`, { method: "POST", json: {} }),
    onMutate: (n) => {
      const now = new Date().toISOString();
      let changed = false;
      qc.setQueryData<ListData>(LIST_KEY, (data) =>
        data && {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: p.items.map((i) => {
              if (i._id !== n._id || i.readAt) return i;
              changed = true;
              return { ...i, readAt: now };
            }),
          })),
        },
      );
      if (changed) {
        qc.setQueryData<UnreadCount>(COUNT_KEY, (c) => {
          if (!c) return c;
          const byBusiness = { ...c.byBusiness };
          const b = n.business?._id;
          if (b && byBusiness[b]) byBusiness[b] -= 1;
          return { total: Math.max(0, c.total - 1), byBusiness };
        });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: COUNT_KEY }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ updated: number }>("/api/notifications/read-all", { method: "POST", json: {} }),
    onMutate: () => {
      const now = new Date().toISOString();
      qc.setQueryData<ListData>(LIST_KEY, (data) => data && { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, readAt: i.readAt ?? now })) })) });
      qc.setQueryData<UnreadCount>(COUNT_KEY, (c) => c && { total: 0, byBusiness: {} });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

/** Marks one read without a hook (a tapped push). Failures don't matter: the badge refreshes anyway. */
export async function markReadById(id: string) {
  try {
    await api(`/api/notifications/${idSegment(id)}/read`, { method: "POST", json: {} });
  } catch {
    // A push with a bad id lands here too.
  }
}
