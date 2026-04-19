import "dotenv/config";
import { randomUUID } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { createServer } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { rateLimiter } from "hono-rate-limiter";
import { ZodError } from "zod";
import { jsonError } from "@/lib/api-response";
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
const corsOrigins = [process.env.APP_URL, process.env.NEXT_UP_URL]
  .map((origin) => origin?.trim())
  .filter(Boolean) as string[];

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: corsOrigins,
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
    return fromZodError(err, c).toResponse(c);
  }
  // Try Prisma known errors
  const mapped = tryMapPrismaError(err);
  if (mapped) {
    return mapped.toResponse(c);
  }
  const errorId = randomUUID();
  appLogger.error("unhandled_error", {
    errorId,
    locale: c.get("locale"),
    localeSource: c.get("localeSource"),
    error: err,
  });
  return jsonError(c, {
    status: httpCodes.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_SERVER_ERROR",
    messageKey: "common.internalServerError",
    details: { errorId },
  });
});

// 404 handler
app.notFound((c) => {
  return jsonError(c, {
    status: httpCodes.NOT_FOUND,
    code: "NOT_FOUND",
    messageKey: "common.notFound",
  });
});

import { initSocket } from "@/lib/socket";

const port = process.env.PORT || DEFAULT_PORT;
const host = process.env.HOST || "0.0.0.0";

type NodeServer = ReturnType<typeof createServer>;

let server: NodeServer | null = null;

function getRequestBody(
  req: IncomingMessage
): ReadableStream<Uint8Array> | null {
  if (!req.method || req.method === "GET" || req.method === "HEAD") {
    return null;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      req.on("end", () => {
        controller.close();
      });
      req.on("error", (err) => {
        controller.error(err);
      });
    },
  });
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const hostHeader = req.headers.host ?? `${host}:${port}`;
  const url = new URL(req.url ?? "/", `http://${hostHeader}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(
    req.headers as IncomingHttpHeaders
  )) {
    if (typeof value === "string") {
      headers.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: getRequestBody(req),
  });

  const response = await app.fetch(request);
  res.statusCode = response.status;

  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }

  const body = await response.arrayBuffer();
  res.end(Buffer.from(body));
}

if (import.meta.main) {
  server = createServer((req, res) => {
    handleNodeRequest(req, res).catch((error: unknown) => {
      appLogger.error("http.server_error", { error });
      res.statusCode = httpCodes.INTERNAL_SERVER_ERROR;
      res.end("Internal Server Error");
    });
  });

  initSocket(server);

  server.listen(Number(port), host);
  appLogger.info(`Server is running on ${host}:${port}`);
}

export { server };
