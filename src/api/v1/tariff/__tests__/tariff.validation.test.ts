import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware";
import { createProductSchema, updateProductSchema } from "../tariff.validation";

const terminologyFields = [
  "icd11Code",
  "loincCode",
  "snomedCode",
  "ichiCode",
  "nationalTariffCode",
] as const;

describe("tariff product terminology validation", () => {
  for (const field of terminologyFields) {
    it(`rejects ${field} on create and update`, () => {
      expect(
        createProductSchema.safeParse({
          name: "Consultation",
          code: "CONSULT",
          [field]: "client-supplied",
        }).success
      ).toBe(false);
      expect(
        updateProductSchema.safeParse({ [field]: "client-supplied" }).success
      ).toBe(false);
    });
  }

  it("returns HTTP 400 before the handler runs", async () => {
    const app = new Hono();
    let handlerRan = false;
    app.post("/", validate(createProductSchema), (c) => {
      handlerRan = true;
      return c.json({ success: true });
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Consultation",
        code: "CONSULT",
        icd11Code: "1A00",
      }),
    });

    expect(response.status).toBe(400);
    expect(handlerRan).toBe(false);
  });
});
