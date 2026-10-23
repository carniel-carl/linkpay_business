import { Router } from "express";
import { acceptInvite, getInvite, registerFromInvite } from "../controllers/invites";
import { requireAuth } from "../middleware/auth";
import { limiter } from "../middleware/rateLimits";

// Public invite links (the recipient may not have an account yet).
export const invitesRouter = Router();

const inviteLimiter = limiter("invites", { limit: 30 });

invitesRouter.get("/:token", inviteLimiter, getInvite);
invitesRouter.post("/:token/accept", inviteLimiter, requireAuth, acceptInvite);
invitesRouter.post("/:token/register", inviteLimiter, registerFromInvite);
