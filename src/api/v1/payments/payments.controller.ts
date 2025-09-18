import type { Context } from "hono";
import type {
  PaymentStatus,
  PaymentType,
  Prisma,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";

export const listPayments = async (c: Context) => {
  try {
    const { page = "1", limit = "10", type = "", status = "" } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.PaymentWhereInput = {};
    if (type) {
      where.paymentType = type as PaymentType;
    }
    if (status) {
      where.paymentStatus = status as PaymentStatus;
    }

    const [payments, total] = await Promise.all([
      db.payment.findMany({
        where,
        skip,
        take,
        include: {
          visit: { include: { patient: true, doctor: true } },
          clinic: true,
          branch: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      db.payment.count({ where }),
    ]);

    return c.json({
      data: payments,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
