import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rateLimiter } from "hono-rate-limiter";
import { ZodError } from "zod";
import { AppError, fromZodError, tryMapPrismaError } from "@/lib/app-error";
import { logger as appLogger } from "@/lib/logger";
import { startRecurringJobs } from "./jobs";
import { httpCodes } from "./lib/constants";
// Import main routes (will mount versioned routers)
import mainRoutes from "./routes";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const ONE_MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const RATE_LIMIT_WINDOW_MINUTES = 5;
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * ONE_MINUTE_MS;
const RATE_LIMIT_MAX_REQUESTS = 200;
const DEFAULT_PORT = 4002;

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [process.env.APP_URL as string, process.env.NEXT_UP_URL as string],
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
    skip: (c) =>
      c.req.path === "/api/v1/auth/get-session" && c.req.method === "GET",
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

if (import.meta.main && process.env.NODE_ENV !== "test") {
  startRecurringJobs();
}

// Error handling
app.onError((err, c) => {
  // Known AppError
  if (err instanceof AppError) {
    return err.toResponse(c);
  }
  // Zod validation errors not caught upstream
  if (err instanceof ZodError) {
    return fromZodError(err).toResponse(c);
  }
  // Try Prisma known errors
  const mapped = tryMapPrismaError(err);
  if (mapped) {
    return mapped.toResponse(c);
  }
  const errorId = randomUUID();
  appLogger.error("unhandled_error", { errorId, error: err });
  return c.json(
    {
      success: false,
      status: httpCodes.INTERNAL_SERVER_ERROR,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Something went wrong",
        errorId,
      },
    },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      status: httpCodes.NOT_FOUND,
      error: { code: "NOT_FOUND", message: "Not Found" },
    },
    httpCodes.NOT_FOUND as ContentfulStatusCode
  );
});

import { initSocket } from "@/lib/socket";

const port = process.env.PORT || DEFAULT_PORT;
const host = process.env.HOST || "0.0.0.0";

// Define minimal Bun types locally to avoid using 'any'
type BunServer = {
  stop: () => void;
  // Add other properties if needed
};

type BunServeOptions = {
  port: string | number;
  hostname: string;
  fetch: (req: Request) => Response | Promise<Response>;
};

type BunRuntime = {
  serve: (options: BunServeOptions) => BunServer;
};

declare const Bun: BunRuntime;

let server: BunServer | null = null;

if (import.meta.main) {
  server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  initSocket(server);

  appLogger.info(`Server is running on ${host}:${port}`);
}

export { server };
