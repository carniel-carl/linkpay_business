import type { RequestHandler } from "express";
import { touchSession } from "../services/sessions";
import { verifyAccessToken } from "../services/tokens";
import { HttpError } from "../utils/HttpError";
import { assertSupportedApp } from "./appVersion";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** The session the access token belongs to: a device (the mobile app) or a browser (the web). */
      sessionId?: string;
    }
  }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
  const { userId, sessionId } = await verifyAccessToken(header.slice(7));
  const state = await touchSession(sessionId, userId);
  // A token stops working as soon as its session is signed out, revoked or expired, or the password it signed in
  // with is changed or reset.
  if (state === "ended") throw new HttpError(401, "This session has been signed out.", "SESSION_REVOKED");
  // A session can outlive its account if the account is deleted without ending it.
  if (state === "no_account") throw new HttpError(401, "This account no longer exists. Sign in again.", "UNAUTHENTICATED");
  // A device session is the mobile app even when the request doesn't say so (builds from before the version check
  // send no X-App-Version), so it must be a version this API still works with. Browsers are never asked.
  if (state === "device") assertSupportedApp(req, req.get("x-app-version"));
  req.userId = userId;
  req.sessionId = sessionId;
  next();
};
