import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants.ts";
import { getUserAvailability } from "@/services/availability.service.ts";

export const getAvailabilityByUserId = async (c: Context) => {
  try {
    const { userId } = c.get("validatedParam") as { userId: number };
    const { date, branchId, slotMinutes } = c.get("validatedQuery") as {
      date: Date;
      branchId?: number;
      slotMinutes?: number;
    };
    const { availableTimes } = await getUserAvailability({
      userId,
      date,
      branchId,
      slotMinutes,
    });
    return c.json(
      { data: { availableTimes } },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
