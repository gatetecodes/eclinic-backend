import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";

const router = new Hono();

router.post("/upload", (c) => {
  try {
    return c.json(
      { message: "File upload endpoint - to be implemented" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
});

export default router;
