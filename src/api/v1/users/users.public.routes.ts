import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware.ts";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { resendVerificationEmail } from "./users.controller.ts";
import { resendVerificationSchema } from "./users.validation.ts";

const router = new Hono<AppEnv>();

router.post(
  "/resend-verification",
  validate(resendVerificationSchema, "json"),
  resendVerificationEmail
);

export default router;
