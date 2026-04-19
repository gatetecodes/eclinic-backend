import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import { ZodError } from "zod";
import { fromZodError } from "@/lib/app-error";

export const validate = <T>(
  schema: z.ZodSchema<T>,
  target: "query" | "json" | "param" = "json"
) =>
  createMiddleware(async (c, next) => {
    try {
      let body: unknown;
      if (target === "json") {
        const text = await c.req.text();
        body = text.trim() === "" ? {} : JSON.parse(text);
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
        return fromZodError(error, c).toResponse(c);
      }
      throw error;
    }
  });
