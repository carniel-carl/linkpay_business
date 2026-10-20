import { Router } from "express";
import { createBranch, getBranch, listBranches, updateBranch } from "../controllers/branches";
import { requireAuth } from "../middleware/auth";
import { requireApprovedBusiness, requirePermission } from "../middleware/roles";

export const branchesRouter = Router();

branchesRouter.use(requireAuth, requireApprovedBusiness);

branchesRouter.get("/", listBranches);
branchesRouter.post("/", requirePermission("branches.manage"), createBranch);
branchesRouter.get("/:id", getBranch);
branchesRouter.patch("/:id", requirePermission("branches.manage"), updateBranch);
