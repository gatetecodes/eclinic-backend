import { type Context } from "hono";
import { db } from "../../../database/db";
import {
  createApprovalSchema,
  processApprovalSchema,
} from "./approvals.validation.ts";

export const createApprovalRequest = async (c: Context) => {
  try {
    const user = c.get("user");
    const json = await c.req.json();
    const parsed = createApprovalSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { type, reason, discountId } = parsed.data;

    const approval = await db.approval.create({
      data: {
        type,
        clinicId: Number(user.clinic.id),
        branchId: Number(user.branch.id),
        requestedById: Number(user.id),
        reason,
        ...(discountId ? { discountId } : {}),
      },
    });

    return c.json({ success: true, data: approval }, 201);
  } catch (error) {
    console.error("createApprovalRequest error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const processApprovalRequest = async (c: Context) => {
  try {
    const user = c.get("user");
    const approvalId = Number(c.req.param("id"));
    const json = await c.req.json();
    const parsed = processApprovalSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { approve } = parsed.data;

    const approval = await db.approval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) return c.json({ error: "Approval request not found" }, 404);

    await db.approval.update({
      where: { id: approvalId },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        approvedById: Number(user.id),
      },
      include: { discount: true },
    });

    if (approval.type === "DISCOUNT" && approval.discountId) {
      await db.discount.update({
        where: { id: approval.discountId },
        data: { approvalId: approvalId },
      });
    }

    return c.json({
      success: true,
      message: `Request successfully ${approve ? "approved" : "rejected"}`,
    });
  } catch (error) {
    console.error("processApprovalRequest error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const getApprovalRequests = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.req.query();
    const take = query["take"] ? Number(query["take"]) : undefined;
    const skip = query["skip"] ? Number(query["skip"]) : undefined;
    const orderByField = (query["orderByField"] as string) || "updatedAt";
    const orderByDirection =
      (query["orderByDirection"] as "asc" | "desc") || "desc";

    const [approvalRequests, totalCount] = await Promise.all([
      db.approval.findMany({
        take,
        skip,
        where: {
          clinicId: Number(user.clinic.id),
          branchId: Number(user.branch.id),
        },
        orderBy: { [orderByField]: orderByDirection },
        select: {
          id: true,
          type: true,
          status: true,
          reason: true,
          updatedAt: true,
          requestedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
          discount: { select: { amount: true, reason: true } },
        },
      }),
      db.approval.count({
        where: {
          clinicId: Number(user.clinic.id),
          branchId: Number(user.branch.id),
        },
      }),
    ]);

    const pageCount = take ? Math.ceil(totalCount / take) : 0;
    return c.json({ data: approvalRequests, totalCount, pageCount });
  } catch (error) {
    console.error("getApprovalRequests error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
