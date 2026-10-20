import type { RequestHandler } from "express";
import { isSessionActive } from "../services/sessions";
import { verifyAccessToken } from "../services/tokens";
import { HttpError } from "../utils/HttpError";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /** Set when the access token belongs to a device session (the mobile app). */
      sessionId?: string;
    }
  }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
  const { userId, sessionId } = await verifyAccessToken(header.slice(7));
  // Device-session tokens stop working as soon as the session is signed out or revoked.
  if (sessionId && !(await isSessionActive(sessionId, userId))) {
    throw new HttpError(401, "This session has been signed out.", "SESSION_REVOKED");
  }
  req.userId = userId;
  req.sessionId = sessionId;
  next();
};
