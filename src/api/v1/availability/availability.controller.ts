import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants.ts";
import { getUserAvailability } from "@/services/availability.service.ts";

export const getAvailabilityByUserId = async (c: Context) => {
  try {
    const { userId } = c.req.param() as { userId: string };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const query = c.req.query();
    const dateStr = query?.date as string | undefined;
    if (!dateStr) {
      return c.json(
        { error: "Missing date parameter" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const date = new Date(dateStr);
    const branchId = query?.branchId
      ? Number.parseInt(String(query.branchId), 10)
      : undefined;
    const slotMinutes = query?.slotMinutes
      ? Number.parseInt(String(query.slotMinutes), 10)
      : undefined;
    const { availableTimes } = await getUserAvailability({
      userId: Number.parseInt(userId, 10),
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
