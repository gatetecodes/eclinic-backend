import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ClaimStatus,
  type InsuranceClaim,
  PaymentStatus,
  type Prisma,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { getScope } from "../../../lib/request-scope";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";

export const getInsuranceClaims = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<InsuranceClaim>(params, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });
    const { where, orderBy, ...restOptions } = queryOptions;
    const cacheKey = `insurance-claims:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;

    const insuranceClaimsData = await getCachedData(
      cacheKey,
      async () => {
        const claims = await db.insuranceClaim.findMany({
          where: {
            ...where,
          } as Prisma.InsuranceClaimWhereInput,
          orderBy: orderBy as Prisma.InsuranceClaimOrderByWithRelationInput,
          ...restOptions,
          include: {
            visit: {
              select: {
                id: true,
                prescriptions: {
                  select: {
                    id: true,
                    items: {
                      select: {
                        id: true,
                        medicationName: true,
                        dosage: true,
                        frequency: true,
                        duration: true,
                        instructions: true,
                      },
                    },
                  },
                },
                patient: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    phoneNumber: true,
                  },
                },
                patientInsurance: {
                  select: {
                    id: true,
                    insuranceNumber: true,
                    insuranceCompany: {
                      select: {
                        companyName: true,
                      },
                    },
                    coveragePercentage: true,
                  },
                },
              },
            },
          },
        });
        const totalCount = await db.insuranceClaim.count({
          where: {
            ...where,
          } as Prisma.InsuranceClaimWhereInput,
        });

        const stats = await db.insuranceClaim.groupBy({
          by: ["claimStatus"],
          where: {
            ...where,
          } as Prisma.InsuranceClaimWhereInput,
          _sum: {
            totalAmount: true,
          },
          _count: true,
        });

        const companiesWithClaims = await db.insuranceClaim.findMany({
          where: {
            ...where,
          } as Prisma.InsuranceClaimWhereInput,
          select: {
            visit: {
              select: {
                patientInsurance: {
                  select: {
                    insuranceCompany: {
                      select: {
                        companyName: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        const uniqueCompanies = new Set(
          companiesWithClaims
            .map(
              (claim) =>
                claim.visit?.patientInsurance?.insuranceCompany?.companyName
            )
            .filter(Boolean)
        );

        const totalAmounts = stats.reduce(
          (acc, curr) => {
            acc[curr.claimStatus] = Number(curr._sum.totalAmount || 0);
            return acc;
          },
          {} as Record<ClaimStatus, number>
        );

        const countsByStatus = stats.reduce(
          (acc, curr) => {
            acc[curr.claimStatus] = curr._count;
            return acc;
          },
          {} as Record<ClaimStatus, number>
        );

        const pageCount = queryOptions.take
          ? Math.ceil(totalCount / queryOptions.take)
          : 0;

        return {
          data: claims,
          totalCount,
          pageCount,
          stats: {
            totalCompanies: uniqueCompanies.size,
            totalAmount: Object.values(totalAmounts).reduce((a, b) => a + b, 0),
            amountsByStatus: totalAmounts,
            countsByStatus,
          },
        };
      },
      DEFAULT_CACHE_TTL.MEDIUM
    );
    return c.json(
      {
        data: insuranceClaimsData,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const markInsuranceClaimAsPaid = async (c: Context) => {
  try {
    const claimId = c.get("validatedParam");
    const data = c.get("validatedJson");

    const insuranceClaim = await db.insuranceClaim.findUnique({
      where: {
        id: claimId,
      },
    });

    if (!insuranceClaim) {
      return c.json(
        { error: "Insurance claim not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (insuranceClaim.claimStatus === ClaimStatus.PAID) {
      return c.json(
        { error: "Insurance claim already paid" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await db.$transaction(async (tx) => {
      // Mark claim as paid
      await tx.insuranceClaim.update({
        where: { id: insuranceClaim.id },
        data: {
          claimStatus: ClaimStatus.PAID,
          paidAt: new Date(),
          paymentMethod: data.paymentMethod,
        },
      });

      // Mark all linked payments as FULLY_PAID and update paid amount
      const claimPayments = await tx.payment.findMany({
        where: { insuranceClaimId: insuranceClaim.id },
        select: {
          id: true,
          paidAmount: true,
          insuranceAmount: true,
        },
      });

      for (const payment of claimPayments) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            paymentStatus: PaymentStatus.FULLY_PAID,
            paidAmount:
              Number(payment.paidAmount) + Number(payment.insuranceAmount),
          },
        });
      }
    });

    return c.json(
      { success: "Insurance claim marked as paid" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
