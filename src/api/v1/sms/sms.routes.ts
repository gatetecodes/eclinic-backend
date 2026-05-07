import { Hono } from "hono";
import { smsStatusWebhook } from "./sms.controller";

const smsRouter = new Hono();

// Public webhook endpoint consumed by Twilio
smsRouter.post("/webhook/status", smsStatusWebhook);

export default smsRouter;
