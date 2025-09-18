import { Hono } from "hono";
import {
  deleteUser,
  getUserById,
  listUsers,
  updateUser,
} from "./users.controller.ts";

const router = new Hono();

router.get("/", listUsers);
router.get("/:id", getUserById);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);

export default router;
