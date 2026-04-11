import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { invalidatePaymentRelatedCaches } from "@/lib/cache-utils.ts";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger.ts";
import { getScope } from "@/lib/request-scope.ts";
import type { Prisma } from "../../../../generated/prisma/client";
import { PaymentType } from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { getPaymentStatusAfterAdjustment } from "../../../helpers/refund-helpers";
import { applyApprovedRefund } from "../../../helpers/refund-workflow";
import { createPaymentForProducts } from "../../../helpers/tariff-helpers";
import {
  createApprovalSchema,
  processApprovalSchema,
} from "./approvals.validation.ts";

export const createApprovalRequest = async (c: Context) => {
  try {
    const user = c.get("user");
    const json = await c.req.json();
    const parsed = createApprovalSchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const data = parsed.data;

    const approval = await db.approval.create({
      data: {
        type: data.type,
        clinicId: Number(user.clinicId || user.clinic.id),
        branchId: user.branchId != null ? Number(user.branchId) : undefined,
        requestedById: Number(user.id),
        reason: data.reason,
        discountId: "discountId" in data ? data.discountId : undefined,
        examId: "examId" in data ? data.examId : undefined,
        treatmentId: "treatmentId" in data ? data.treatmentId : undefined,
        payload:
          "payload" in data
            ? (data.payload as Prisma.InputJsonValue)
            : undefined,
      },
    });

    return c.json(
      { success: true, data: approval },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Error creating approval request:", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Approval processing branches by type
export const processApprovalRequest = async (c: Context) => {
  try {
    const user = c.get("user");
    const approvalId = Number(c.req.param("id"));
    const json = await c.req.json();
    const parsed = processApprovalSchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { approve } = parsed.data;

    const approval = await db.approval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) {
      return c.json(
        { error: "Approval request not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (approve && approval.type === "REFUND") {
      const fullApproval = await db.approval.findUnique({
        where: { id: approvalId },
        select: { id: true, clinicId: true, reason: true, payload: true },
      });

      if (!fullApproval?.payload) {
        return c.json(
          { error: "Invalid refund approval payload" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }

      const rawPayload = fullApproval.payload as Record<string, unknown>;

      if (rawPayload.examEditRefund === true) {
        // Exam-edit refund path: consolidated refund for removed exam products
        const editRefundPayload = rawPayload as {
          paymentId: number;
          visitId: number;
          examId: number;
          items: Array<{
            productId: number;
            productName: string;
            patientRefundAmount: number;
            insuranceAdjustmentAmount: number;
            totalAdjustmentAmount: number;
          }>;
          requested: {
            refund: {
              patientRefundAmount: number;
              insuranceAdjustmentAmount: number;
              totalAdjustmentAmount: number;
            };
          };
        };

        const payment = await db.payment.findUnique({
          where: { id: editRefundPayload.paymentId },
          select: {
            id: true,
            clinicId: true,
            visitId: true,
            paymentMode: true,
            amount: true,
            patientAmount: true,
            insuranceAmount: true,
            paidAmount: true,
          },
        });

        if (!payment || payment.clinicId !== fullApproval.clinicId) {
          return c.json(
            { error: "Payment not found" },
            httpCodes.NOT_FOUND as ContentfulStatusCode
          );
        }

        await db.$transaction(async (tx) => {
          await tx.approval.update({
            where: { id: approvalId, status: "PENDING" },
            data: {
              status: "APPROVED",
              approvedById: Number(user.id),
            },
          });

          // Create a refund record for each removed item
          const items = editRefundPayload.items || [];
          for (const item of items) {
            if (item.productId) {
              await tx.refund.create({
                data: {
                  clinic: { connect: { id: fullApproval.clinicId } },
                  payment: { connect: { id: payment.id } },
                  visit: { connect: { id: payment.visitId as number } },
                  product: { connect: { id: item.productId } },
                  approval: { connect: { id: approvalId } },
                  refundedBy: { connect: { id: Number(user.id) } },
                  patientRefundAmount: item.patientRefundAmount,
                  insuranceAdjustmentAmount: item.insuranceAdjustmentAmount,
                  totalAdjustmentAmount: item.totalAdjustmentAmount,
                  reason:
                    fullApproval.reason ??
                    `Refund for removed exam: ${item.productName}`,
                },
              });
            }
          }

          // Adjust payment totals
          const { patientRefundAmount, insuranceAdjustmentAmount } =
            editRefundPayload.requested.refund;
          const totalLineAmount =
            patientRefundAmount + insuranceAdjustmentAmount;

          const nextAmount = Number(
            Math.max(0, Number(payment.amount) - totalLineAmount).toFixed(2)
          );
          const nextPatientAmount = Number(
            Math.max(
              0,
              Number(payment.patientAmount) - patientRefundAmount
            ).toFixed(2)
          );
          const nextInsuranceAmount = Number(
            Math.max(
              0,
              Number(payment.insuranceAmount ?? 0) - insuranceAdjustmentAmount
            ).toFixed(2)
          );
          const nextPaidAmount = Number(
            Math.max(
              0,
              Number(payment.paidAmount) - patientRefundAmount
            ).toFixed(2)
          );

          const nextStatus = getPaymentStatusAfterAdjustment({
            paymentMode: payment.paymentMode as "PRIVATE" | "INSURANCE",
            patientAmount: nextPatientAmount,
            paidAmount: nextPaidAmount,
          });

          await tx.payment.update({
            where: { id: payment.id },
            data: {
              amount: nextAmount,
              patientAmount: nextPatientAmount,
              insuranceAmount: nextInsuranceAmount,
              paidAmount: nextPaidAmount,
              paymentStatus: nextStatus,
            },
          });
        });

        await invalidatePaymentRelatedCaches({
          clinicId: Number(user.clinicId),
          branchId: Number(user.branchId),
        });

        return c.json(
          {
            success: true,
            message: "Exam edit refund approved and applied successfully",
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      // Standard refund path (per-exam-result)
      const payload = fullApproval.payload as Parameters<
        typeof applyApprovedRefund
      >[0]["payload"];

      await db.$transaction(async (tx) => {
        await tx.approval.update({
          where: { id: approvalId, status: "PENDING" },
          data: {
            status: "APPROVED",
            approvedById: Number(user.id),
          },
        });

        await applyApprovedRefund({
          tx,
          approvalId,
          userId: Number(user.id),
          payload,
          reason: fullApproval.reason,
          clinicId: fullApproval.clinicId,
        });
      });

      await invalidatePaymentRelatedCaches({
        clinicId: Number(user.clinicId),
        branchId: Number(user.branchId),
      });

      return c.json(
        {
          success: true,
          message: "Refund request approved and applied successfully",
        },
        httpCodes.OK as ContentfulStatusCode
      );
    }

    if (approve && approval.type === "EXAM_EDIT") {
      const fullApproval = await db.approval.findUnique({
        where: { id: approvalId, status: "PENDING" },
        select: { id: true, payload: true, examId: true },
      });

      if (!fullApproval?.examId) {
        return c.json(
          { error: "Invalid exam edit approval payload" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }

      const exam = await db.exam.findUnique({
        where: { id: fullApproval.examId },
        select: {
          id: true,
          visitId: true,
          results: { select: { id: true } },
        },
      });

      if (!exam) {
        return c.json(
          { error: "Exam not found" },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }

      if (exam.results.length > 0) {
        return c.json(
          {
            error:
              "Exam results already exist for this request. Cannot apply exam edit changes.",
          },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }

      const payloadData = (fullApproval.payload ?? {}) as {
        paymentId?: number;
        paidBill?: boolean;
        original?: { exams?: number[]; allowPartial?: boolean };
        requested?: { exams?: number[]; allowPartial?: boolean };
        exams?: number[];
        allowPartial?: boolean;
      };

      const requested = payloadData?.requested ?? payloadData;
      let requestedExams: number[] = [];
      if (Array.isArray(requested?.exams)) {
        requestedExams = requested.exams;
      } else if (Array.isArray(payloadData?.exams)) {
        requestedExams = payloadData.exams;
      }
      const productIds = requestedExams
        .map((eid: number) => Number(eid))
        .filter((n: number) => !Number.isNaN(n));

      if (productIds.length === 0) {
        return c.json(
          { error: "No exams were provided for this approval request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }

      if (payloadData.paidBill) {
        // Paid bill path: update exams and create payment only for newly added products
        const originalExams = payloadData.original?.exams ?? [];
        const newlyAddedExams = productIds.filter(
          (pid) => !originalExams.includes(pid)
        );

        await db.$transaction(async (tx) => {
          await tx.exam.update({
            where: { id: exam.id },
            data: {
              products: { set: productIds.map((pid) => ({ id: pid })) },
            },
          });

          if (newlyAddedExams.length > 0) {
            await createPaymentForProducts(
              newlyAddedExams,
              exam.visitId,
              PaymentType.ADDITIONAL_EXAM,
              {
                allowPartial:
                  requested?.allowPartial ?? payloadData?.allowPartial ?? false,
                tx,
              }
            );
          }

          await tx.approval.update({
            where: { id: approvalId, status: "PENDING" },
            data: {
              status: "APPROVED",
              approvedById: Number(user.id),
            },
          });
        });
      } else {
        // Pending bill path: cancel existing payment and recreate
        const existingPayment = await db.payment.findFirst({
          where: {
            id: payloadData.paymentId,
            visitId: exam.visitId,
            paymentType: PaymentType.ADDITIONAL_EXAM,
            paymentStatus: "PENDING",
          },
          select: { id: true, paymentStatus: true, allowPartial: true },
        });

        if (!existingPayment) {
          return c.json(
            {
              error: `No existing pending bill found for payment ID: ${payloadData.paymentId}`,
            },
            httpCodes.BAD_REQUEST as ContentfulStatusCode
          );
        }

        await db.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: existingPayment.id },
            data: { paymentStatus: "CANCELLED" },
          });

          await tx.exam.update({
            where: { id: exam.id },
            data: {
              products: { set: productIds.map((pid) => ({ id: pid })) },
            },
          });

          await createPaymentForProducts(
            productIds,
            exam.visitId,
            PaymentType.ADDITIONAL_EXAM,
            {
              allowPartial:
                requested?.allowPartial ??
                payloadData?.allowPartial ??
                existingPayment.allowPartial ??
                false,
              tx,
            }
          );

          await tx.approval.update({
            where: { id: approvalId, status: "PENDING" },
            data: {
              status: "APPROVED",
              approvedById: Number(user.id),
            },
          });
        });
      }

      await invalidatePaymentRelatedCaches({
        clinicId: Number(user.clinicId),
        branchId: Number(user.branchId),
      });

      return c.json(
        { success: true, message: "Exam edit applied successfully" },
        httpCodes.OK as ContentfulStatusCode
      );
    }

    await db.approval.update({
      where: { id: approvalId, status: "PENDING" },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        approvedById: Number(user.id),
      },
      include: { discount: true },
    });

    if (approval.type === "DISCOUNT" && approval.discountId) {
      await db.discount.update({
        where: { id: approval.discountId },
        data: { approval: { connect: { id: approvalId } } },
      });
    }

    await invalidatePaymentRelatedCaches({
      clinicId: Number(user.clinicId),
      branchId: Number(user.branchId),
    });

    return c.json(
      {
        success: true,
        message: `Request successfully ${approve ? "approved" : "rejected"}`,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return c.json(
      { error: message },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

type ProductWithDetails = {
  id: number;
  name: string;
  basePrice: Prisma.Decimal | null;
  eastAfricaPrice: Prisma.Decimal | null;
  africaPrice: Prisma.Decimal | null;
  restOfWorldPrice: Prisma.Decimal | null;
  clinicProductPrices: Array<{
    basePrice: Prisma.Decimal | null;
    eastAfricaPrice: Prisma.Decimal | null;
    africaPrice: Prisma.Decimal | null;
    restOfWorldPrice: Prisma.Decimal | null;
  }>;
  insurancePrices: Array<{
    price: Prisma.Decimal;
    insuranceCompanyId: number;
  }>;
};

type VisitPriceContext = {
  paymentMode: string;
  patient?: {
    nationality?: string | null;
    isAForeigner?: boolean;
    foreignerRegion?: string | null;
  };
  patientInsurance?: {
    coveragePercentage?: Prisma.Decimal | number | null;
    insuranceCompany?: { id: number; companyName: string } | null;
  };
};

type IApprovalPayload = {
  original?: {
    exams?: number[];
    treatments?: Array<{ id: number; quantity?: number }>;
    consumables?: Array<{ id: number; quantity?: number }>;
  };
  requested?: {
    exams?: number[];
    treatments?: Array<{ id: number; quantity?: number }>;
    consumables?: Array<{ id: number; quantity?: number }>;
  };
  exams?: number[];
  treatments?: Array<{ id: number; quantity?: number }>;
  consumables?: Array<{ id: number; quantity?: number }>;
  productId?: number;
  productName?: string;
  items?: Array<{ inventoryItemId: number; quantity?: number; name?: string }>;
};

const getForeignerUnitPrice = (
  product: ProductWithDetails,
  context: VisitPriceContext
): number => {
  const region = context.patient?.foreignerRegion;
  const cp = product.clinicProductPrices[0];
  if (region === "EAST_AFRICA") {
    return Number(cp?.eastAfricaPrice ?? product.eastAfricaPrice ?? 0);
  }
  if (region === "AFRICA") {
    return Number(cp?.africaPrice ?? product.africaPrice ?? 0);
  }
  return Number(cp?.restOfWorldPrice ?? product.restOfWorldPrice ?? 0);
};

const getUnitPrice = (
  product: ProductWithDetails,
  visit: VisitPriceContext
): number => {
  const isInsurance = visit.paymentMode === "INSURANCE";
  const insuranceCompanyId = visit.patientInsurance?.insuranceCompany?.id;

  if (isInsurance && insuranceCompanyId) {
    const ip = product.insurancePrices.find(
      (p) => p.insuranceCompanyId === insuranceCompanyId
    );
    return Number(ip?.price || 0);
  }

  const isRwandan =
    visit.patient?.nationality === "Rwanda" && !visit.patient?.isAForeigner;
  if (isRwandan) {
    const cp = product.clinicProductPrices[0];
    return Number(cp?.basePrice ?? product.basePrice ?? 0);
  }

  return getForeignerUnitPrice(product, visit);
};

const buildPricedItems = (
  items: unknown[],
  visit: VisitPriceContext | undefined,
  type: string,
  productMap: Map<number, ProductWithDetails>
) => {
  if (!visit) {
    return items;
  }
  const isInsurance = visit.paymentMode === "INSURANCE";
  const coverage =
    Number(visit.patientInsurance?.coveragePercentage || 0) / 100;

  return items.map((item: unknown) => {
    const itemData = item as { id?: number; quantity?: number };
    const idNum = Number(type === "EXAM_EDIT" ? item : itemData.id);
    const qty = type === "EXAM_EDIT" ? 1 : Number(itemData.quantity || 1);
    const product = productMap.get(idNum);

    if (!product) {
      return type === "EXAM_EDIT" ? { id: idNum } : item;
    }

    const unitPrice = getUnitPrice(product, visit);
    const amount = unitPrice * qty;
    const insuranceAmount = isInsurance ? amount * coverage : 0;
    const patientAmount = amount - insuranceAmount;

    return {
      ...(type === "EXAM_EDIT" ? {} : itemData),
      id: idNum,
      name: product.name,
      quantity: qty,
      unitPrice,
      amount,
      patientAmount,
      insuranceAmount,
    };
  });
};

const addSnapshotIdsToSets = (
  snapshot: IApprovalPayload | undefined,
  productIdsSet: Set<number>,
  inventoryIdsSet: Set<number>
) => {
  if (!snapshot) {
    return;
  }
  const exams = Array.isArray(snapshot.exams) ? snapshot.exams : [];
  for (const id of exams) {
    if (typeof id === "number") {
      productIdsSet.add(id);
    }
  }
  const treatments = Array.isArray(snapshot.treatments)
    ? snapshot.treatments
    : [];
  for (const t of treatments) {
    if (typeof t?.id === "number") {
      productIdsSet.add(t.id);
    }
  }
  const consumables = Array.isArray(snapshot.consumables)
    ? snapshot.consumables
    : [];
  for (const c of consumables) {
    if (typeof c?.id === "number") {
      inventoryIdsSet.add(c.id);
    }
  }
};

const addIdsToSets = (
  payload: IApprovalPayload,
  productIdsSet: Set<number>,
  inventoryIdsSet: Set<number>,
  type: string
) => {
  if (type === "EXAM_EDIT" || type === "TREATMENT_EDIT") {
    addSnapshotIdsToSets(payload.original, productIdsSet, inventoryIdsSet);
    addSnapshotIdsToSets(payload.requested, productIdsSet, inventoryIdsSet);
    addSnapshotIdsToSets(payload, productIdsSet, inventoryIdsSet);
  } else if (type === "EXTRA_INVENTORY") {
    if (typeof payload.productId === "number") {
      productIdsSet.add(payload.productId);
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const it of items) {
      if (typeof it.inventoryItemId === "number") {
        inventoryIdsSet.add(it.inventoryItemId);
      }
    }
  }
};

const collectIdsForEnrichment = (
  approvals: { payload: unknown; type: string }[]
) => {
  const productIdsSet = new Set<number>();
  const inventoryIdsSet = new Set<number>();

  for (const a of approvals) {
    if (a.payload) {
      addIdsToSets(
        a.payload as IApprovalPayload,
        productIdsSet,
        inventoryIdsSet,
        a.type
      );
    }
  }

  return {
    productIds: Array.from(productIdsSet),
    inventoryIds: Array.from(inventoryIdsSet),
  };
};

const fetchProductsWithDetails = (productIds: number[], clinicId: number) => {
  if (productIds.length === 0) {
    return Promise.resolve([]);
  }
  return db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      basePrice: true,
      eastAfricaPrice: true,
      africaPrice: true,
      restOfWorldPrice: true,
      clinicProductPrices: {
        where: { clinicId },
        select: {
          basePrice: true,
          eastAfricaPrice: true,
          africaPrice: true,
          restOfWorldPrice: true,
        },
        take: 1,
      },
      insurancePrices: {
        where: { OR: [{ clinicId }, { clinicId: null }] },
        select: {
          price: true,
          insuranceCompanyId: true,
        },
      },
    },
  });
};

const fetchInventoryNames = (inventoryIds: number[]) => {
  if (inventoryIds.length === 0) {
    return Promise.resolve([]);
  }
  return db.inventoryItem.findMany({
    where: { id: { in: inventoryIds } },
    select: { id: true, itemName: true },
  });
};

type EnrichmentContext = {
  productMap: Map<number, ProductWithDetails>;
  inventoryMap: Map<number, string>;
};

const enrichTarget = (
  data: IApprovalPayload | undefined,
  type: string,
  visit: VisitPriceContext | undefined,
  ctx: EnrichmentContext
) => {
  if (!data) {
    return;
  }
  const enriched = { ...data };
  if (type === "EXAM_EDIT") {
    enriched.exams = buildPricedItems(
      data.exams || [],
      visit,
      "EXAM_EDIT",
      ctx.productMap
    ) as number[];
  } else {
    enriched.treatments = buildPricedItems(
      data.treatments || [],
      visit,
      "TREATMENT_EDIT",
      ctx.productMap
    ) as Array<{ id: number; quantity?: number }>;
    enriched.consumables = (data.consumables || []).map((cons) => ({
      ...cons,
      name: ctx.inventoryMap.get(cons.id) || `Item #${cons.id}`,
    }));
  }
  return enriched;
};

const enrichApprovals = (
  approvalRequests: {
    payload: unknown;
    type: string;
    treatment?: { visit: unknown } | null;
    exam?: { visit: unknown } | null;
  }[],
  ctx: EnrichmentContext
) => {
  return approvalRequests.map((a) => {
    const payload = a.payload as IApprovalPayload;
    if (!payload) {
      return a;
    }

    const visit = (a.treatment?.visit || a.exam?.visit) as unknown as
      | VisitPriceContext
      | undefined;

    if (a.type === "EXAM_EDIT" || a.type === "TREATMENT_EDIT") {
      const enrichedPayload = { ...payload };
      enrichedPayload.original = enrichTarget(
        payload.original,
        a.type,
        visit,
        ctx
      );
      enrichedPayload.requested = enrichTarget(
        payload.requested,
        a.type,
        visit,
        ctx
      );
      return { ...a, payload: enrichedPayload };
    }

    if (a.type === "EXTRA_INVENTORY") {
      const enrichedPayload = { ...payload };
      if (payload.productId) {
        enrichedPayload.productName = ctx.productMap.get(
          payload.productId
        )?.name;
      }
      if (payload.items) {
        enrichedPayload.items = payload.items.map((it) => ({
          ...it,
          name:
            ctx.inventoryMap.get(it.inventoryItemId) ||
            `Item #${it.inventoryItemId}`,
        }));
      }
      return { ...a, payload: enrichedPayload };
    }

    return a;
  });
};

export const getApprovalRequests = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.req.query();
    const take = query.take ? Number(query.take) : undefined;
    const skip = query.skip ? Number(query.skip) : undefined;
    const orderByField = (query.orderByField as string) || "updatedAt";
    const orderByDirection =
      (query.orderByDirection as "asc" | "desc") || "desc";

    const { clinicId, branchId } = getScope(user, query);

    const where: Prisma.ApprovalWhereInput = {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    };

    const [approvalRequests, totalCount] = await Promise.all([
      db.approval.findMany({
        take,
        skip,
        where: {
          ...where,
        },
        orderBy: { [orderByField]: orderByDirection },
        select: {
          id: true,
          type: true,
          status: true,
          reason: true,
          payload: true,
          createdAt: true,
          updatedAt: true,
          requestedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
          discount: { select: { amount: true, reason: true } },
          treatment: {
            select: {
              id: true,
              name: true,
              visit: {
                select: {
                  id: true,
                  paymentMode: true,
                  patient: {
                    select: {
                      firstName: true,
                      lastName: true,
                      isAForeigner: true,
                      foreignerRegion: true,
                      nationality: true,
                    },
                  },
                  patientInsurance: {
                    select: {
                      coveragePercentage: true,
                      insuranceCompany: {
                        select: { id: true, companyName: true },
                      },
                    },
                  },
                },
              },
            },
          },
          exam: {
            select: {
              id: true,
              name: true,
              products: { select: { id: true } },
              visit: {
                select: {
                  id: true,
                  paymentMode: true,
                  patient: {
                    select: {
                      firstName: true,
                      lastName: true,
                      isAForeigner: true,
                      foreignerRegion: true,
                      nationality: true,
                    },
                  },
                  patientInsurance: {
                    select: {
                      coveragePercentage: true,
                      insuranceCompany: {
                        select: { id: true, companyName: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      db.approval.count({
        where: {
          ...where,
        },
      }),
    ]);

    // Enrich payloads with names and pricing
    const { productIds, inventoryIds } =
      collectIdsForEnrichment(approvalRequests);

    const [products, inventoryItems] = await Promise.all([
      fetchProductsWithDetails(productIds, Number(user.clinicId)),
      fetchInventoryNames(inventoryIds),
    ]);

    const ctx: EnrichmentContext = {
      productMap: new Map(
        products.map((p) => [p.id, p as unknown as ProductWithDetails])
      ),
      inventoryMap: new Map(inventoryItems.map((i) => [i.id, i.itemName])),
    };

    const enriched = enrichApprovals(approvalRequests, ctx);

    const pageCount = take ? Math.ceil(totalCount / take) : 0;
    return c.json(
      { data: enriched, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
