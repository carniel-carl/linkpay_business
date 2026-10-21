import { Router } from "express";
import { staffNotifications, userNotifications } from "../controllers/notifications";
import { requireAuth } from "../middleware/auth";

// Mounted at /api/notifications: the signed-in business user's notifications, across all their businesses.
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", userNotifications.list);
notificationsRouter.get("/unread-count", userNotifications.unreadCount);
notificationsRouter.get("/stream", userNotifications.stream);
notificationsRouter.post("/read-all", userNotifications.markAllRead);
notificationsRouter.post("/push-tokens", userNotifications.registerPushToken);
notificationsRouter.delete("/push-tokens", userNotifications.removePushToken);
notificationsRouter.post("/:id/read", userNotifications.markRead);

// Mounted at /api/admin/notifications, after requireStaff: any staff member, their own notifications.
export const staffNotificationsRouter = Router();
staffNotificationsRouter.get("/", staffNotifications.list);
staffNotificationsRouter.get("/unread-count", staffNotifications.unreadCount);
staffNotificationsRouter.get("/stream", staffNotifications.stream);
staffNotificationsRouter.post("/read-all", staffNotifications.markAllRead);
staffNotificationsRouter.post("/:id/read", staffNotifications.markRead);
