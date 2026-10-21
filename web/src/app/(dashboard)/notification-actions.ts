"use server"

import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { AppNotification, NotificationPage, UnreadCount } from "@/lib/api/types"

const id = z.string().regex(/^[a-f\d]{24}$/i)

/** One page of the bell's list, newest first. Notifications are per user, across all their businesses. */
export async function listNotifications(input: { before?: string; unread?: boolean } = {}) {
  const q = z.object({ before: id.optional(), unread: z.boolean().optional() }).parse(input)
  const params = new URLSearchParams({ take: "20" })
  if (q.before) params.set("before", q.before)
  if (q.unread) params.set("unread", "true")
  return runAction(() => api<NotificationPage>(`/api/notifications?${params}`))
}

export async function markNotificationRead(notificationId: string) {
  const nid = id.parse(notificationId)
  return runAction(() => api<AppNotification>(`/api/notifications/${nid}/read`, { method: "POST" }))
}

export async function markAllNotificationsRead() {
  return runAction(() => api<{ updated: number }>("/api/notifications/read-all", { method: "POST", json: {} }))
}

/** The exact unread total, after read state changed for one business elsewhere. */
export async function unreadNotificationCount() {
  return runAction(async () => (await api<UnreadCount>("/api/notifications/unread-count")).total)
}
