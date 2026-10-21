"use server"

import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { AppNotification, NotificationPage } from "@/lib/api/types"

const BASE = "/api/admin/notifications"

/** A page of the staff member's own notifications, newest first. */
export async function listNotifications(before?: string) {
  const params = new URLSearchParams({ take: "20" })
  if (before) params.set("before", before)
  return runAction(() => api<NotificationPage>(`${BASE}?${params}`))
}

export async function markNotificationRead(id: string) {
  return runAction(() => api<AppNotification>(`${BASE}/${encodeURIComponent(id)}/read`, { method: "POST" }))
}

export async function markAllNotificationsRead() {
  return runAction(() => api<{ updated: number }>(`${BASE}/read-all`, { method: "POST", json: {} }))
}
