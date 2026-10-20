import { Router } from "express";
import { listMyMemberships } from "../controllers/team";
import { requireAuth } from "../middleware/auth";

export const membershipsRouter = Router();

membershipsRouter.get("/", requireAuth, listMyMemberships);
