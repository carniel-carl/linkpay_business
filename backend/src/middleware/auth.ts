import type { RequestHandler } from "express";
import { UserModel } from "../models/User";
import { touchSession } from "../services/sessions";
import { verifyAccessToken } from "../services/tokens";
import { HttpError } from "../utils/HttpError";

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
  // A token stops working as soon as its session is signed out, revoked or expired.
  if (!(await touchSession(sessionId, userId))) {
    throw new HttpError(401, "This session has been signed out.", "SESSION_REVOKED");
  }
  // A session can outlive its account if the account is deleted without ending it.
  if (!(await UserModel.exists({ _id: userId }))) {
    throw new HttpError(401, "This account no longer exists. Sign in again.", "UNAUTHENTICATED");
  }
  req.userId = userId;
  req.sessionId = sessionId;
  next();
};
