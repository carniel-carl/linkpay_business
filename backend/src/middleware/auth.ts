import type { RequestHandler } from "express";
import { verifyToken } from "../services/tokens";
import { HttpError } from "../utils/HttpError";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
  req.userId = await verifyToken(header.slice(7), "access");
  next();
};
