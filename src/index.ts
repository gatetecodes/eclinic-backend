import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rateLimiter } from "hono-rate-limiter";
import { httpCodes } from "./lib/constants";

// Import main routes (will mount versioned routers)
import mainRoutes from "./routes";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const ONE_MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * ONE_MINUTE_MS;
const RATE_LIMIT_MAX_REQUESTS = 100;
const DEFAULT_PORT = 4002;

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.APP_URL as string,
    credentials: true,
  })
);

// Rate limiting
app.use(
  "*",
  rateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS, // 15 minutes
    limit: RATE_LIMIT_MAX_REQUESTS, // limit each IP to 100 requests per windowMs
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for") ??
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-real-ip") ??
      c.req.header("x-client-ip") ??
      c.req.header("host") ??
      "global",
  })
);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// API routes (versioned)
app.route("/api", mainRoutes);

// Error handling
app.onError((err, c) => {
  return c.json(
    {
      error: "Internal Server Error",
      message:
        process.env.NODE_ENV === "development"
          ? err.message
          : "Something went wrong",
      status: httpCodes.INTERNAL_SERVER_ERROR,
    },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );
});

// 404 handler
app.notFound((c) => {
  return c.json(
    { error: "Not Found", status: httpCodes.NOT_FOUND },
    httpCodes.NOT_FOUND as ContentfulStatusCode
  );
});

const port = process.env.PORT || DEFAULT_PORT;

//biome-ignore lint/suspicious/noConsole: <>
console.log(`🚀 eClinic Backend running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
