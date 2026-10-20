import { Router } from "express";
import { deleteUser, getUser, listUsers, updateUser } from "../controllers/users";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Listing or looking up other users exposes emails, so it is limited to platform admins.
usersRouter.get("/", requireAdmin, listUsers);
usersRouter.get("/:id", requireAdmin, getUser);
usersRouter.patch("/:id", updateUser);
usersRouter.delete("/:id", deleteUser);
