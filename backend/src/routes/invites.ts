import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";
import { acceptInvite, getInvite, registerFromInvite } from "../controllers/invites";
import { requireAuth } from "../middleware/auth";

// Public invite links (the recipient may not have an account yet).
export const invitesRouter = Router();

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.nodeEnv === "test",
});

invitesRouter.get("/:token", inviteLimiter, getInvite);
invitesRouter.post("/:token/accept", inviteLimiter, requireAuth, acceptInvite);
invitesRouter.post("/:token/register", inviteLimiter, registerFromInvite);
