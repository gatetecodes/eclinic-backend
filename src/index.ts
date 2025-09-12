import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { rateLimiter } from "hono-rate-limiter";

// Import main routes (will mount versioned routers)
import mainRoutes from "./routes";

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.APP_URL as string,
    credentials: true,
  }),
);

// Rate limiting
app.use(
  "*",
  rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // limit each IP to 100 requests per windowMs
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for") ??
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-real-ip") ??
      c.req.header("x-client-ip") ??
      c.req.header("host") ??
      "global",
  }),
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
  console.error("Error:", err);
  return c.json(
    {
      error: "Internal Server Error",
      message:
        process.env.NODE_ENV === "development"
          ? err.message
          : "Something went wrong",
    },
    500,
  );
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

const port = process.env.PORT || 4002;

console.log(`🚀 eClinic Backend running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
