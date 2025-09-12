import { Hono } from "hono";
import * as UsersController from "./users.controller.ts";

const router = new Hono();

router.get("/", UsersController.listUsers);
router.get("/:id", UsersController.getUserById);
router.put("/:id", UsersController.updateUser);
router.delete("/:id", UsersController.deleteUser);

export default router;
