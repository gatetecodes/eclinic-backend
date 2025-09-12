import { type Context } from "hono";
import { db } from "../../../database/db";
import type {
  Prisma,
  PaymentStatus,
  PaymentType,
} from "../../../../generated/prisma";

export const listPayments = async (c: Context) => {
  try {
    const { page = "1", limit = "10", type = "", status = "" } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: Prisma.PaymentWhereInput = {};
    if (type) where.paymentType = type as PaymentType;
    if (status) where.paymentStatus = status as PaymentStatus;

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
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get payments error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
