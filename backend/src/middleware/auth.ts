import type { RequestHandler } from "express";
import { UserModel } from "../models/User";
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
  const { userId, sessionId, issuedAt } = await verifyAccessToken(header.slice(7));
  // Device-session tokens stop working as soon as the session is signed out or revoked.
  if (sessionId && !(await isSessionActive(sessionId, userId))) {
    throw new HttpError(401, "This session has been signed out.", "SESSION_REVOKED");
  }
  // "Sign out everywhere" (after a "This wasn't me" report): every token issued before then, the web's too.
  // The cut-off is a whole second (tokens carry whole seconds), rounded up so none issued just before survive.
  const user = await UserModel.findById(userId).select("security.sessionsValidAfter").lean();
  const validAfter = user?.security?.sessionsValidAfter?.getTime();
  if (validAfter && issuedAt < validAfter) {
    throw new HttpError(401, "You've been signed out everywhere. Sign in again.", "SESSION_REVOKED");
  }
  req.userId = userId;
  req.sessionId = sessionId;
  next();
};
