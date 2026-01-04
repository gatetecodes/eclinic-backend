import { Hono } from "hono";
import { verify, webhook } from "./whatsapp.controller";

const whatsappRouter = new Hono();

// This should be public (no auth) as it's called by WhatsApp Cloud API
whatsappRouter.get("/webhook", verify);
whatsappRouter.post("/webhook", webhook);

export default whatsappRouter;
