import { Router } from "express";
import { deleteUser, updateUser } from "../controllers/users";
import { requireAuth } from "../middleware/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Listing and looking up users is staff only: GET /api/admin/users and /api/admin/users/:id.
usersRouter.patch("/:id", updateUser);
usersRouter.delete("/:id", deleteUser);
