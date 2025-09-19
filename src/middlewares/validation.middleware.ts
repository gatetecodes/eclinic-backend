import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import { ZodError } from "zod";

export const validate = <T>(
  schema: z.ZodSchema<T>,
  target: "query" | "json" | "param" = "json"
) =>
  createMiddleware(async (c, next) => {
    try {
      let body: unknown;
      if (target === "json") {
        body = await c.req.json();
      } else if (target === "query") {
        body = await c.req.query();
      } else {
        body = await c.req.param();
      }
      const parsed = schema.parse(body);
      c.set(
        `validated${target.charAt(0).toUpperCase() + target.slice(1)}`,
        parsed
      ); //e.g. validatedJson
      await next();
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              details: error.flatten().fieldErrors,
            },
          },
          400
        );
      }
      throw error;
    }
  });
