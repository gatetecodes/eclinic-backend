import { Hono } from "hono";
import { OnboardingController } from "./onboarding.controller";

const onboardingRouter = new Hono();

onboardingRouter.post(
  "/register-queueless",
  OnboardingController.registerQueueLess
);

export default onboardingRouter;
