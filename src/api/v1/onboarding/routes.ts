import { Hono } from "hono";
import { verifyRecaptcha } from "@/middlewares/recaptcha.middleware";
import { OnboardingController } from "./onboarding.controller";

const onboardingRouter = new Hono();

onboardingRouter.post(
  "/register-queueless",
  verifyRecaptcha({ expectedAction: "queueless_register" }),
  OnboardingController.registerQueueLess
);

onboardingRouter.get("/verify-email", OnboardingController.verifyEmail);

export default onboardingRouter;
