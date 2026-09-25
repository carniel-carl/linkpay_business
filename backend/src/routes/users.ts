import { Router } from "express";
import { deleteUser, getUser, listUsers, updateUser } from "../controllers/users";
import { requireAuth } from "../middleware/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get("/", listUsers);
usersRouter.get("/:id", getUser);
usersRouter.patch("/:id", updateUser);
usersRouter.delete("/:id", deleteUser);
