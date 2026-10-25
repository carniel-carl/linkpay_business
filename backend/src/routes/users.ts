import { Router } from "express";
import { deleteUser, updateUser } from "../controllers/users";
import { requireAuth } from "../middleware/auth";
import { authLimits } from "../middleware/rateLimits";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Deleting checks the password, so it's limited like every other route that does: per address, and wrong
// passwords per user across every such route. Otherwise a stolen session could test passwords here without limit.
const deleteLimits = authLimits("users");

// Listing and looking up users is staff only: GET /api/admin/users and /api/admin/users/:id.
usersRouter.patch("/:id", updateUser);
usersRouter.delete("/:id", ...deleteLimits, deleteUser);
