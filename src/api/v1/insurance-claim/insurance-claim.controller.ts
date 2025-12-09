import { Decimal } from "generated/prisma/internal/prismaNamespace";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "@/lib/app-error";
import {
  ClaimStatus,
  type InsuranceClaim,
  PaymentStatus,
  type Prisma,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { getScope } from "../../../lib/request-scope";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
  invalidateCache,
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

    // First check if claim exists (outside transaction for early return)
    const insuranceClaim = await db.insuranceClaim.findUnique({
      where: {
        id: claimId,
      },
      select: {
        id: true,
        clinicId: true,
        branchId: true,
        claimStatus: true,
      },
    });

    if (!insuranceClaim) {
      return c.json(
        { error: "Insurance claim not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Perform atomic conditional update inside transaction
    // This prevents TOCTOU race condition by checking and updating in a single operation
    await db.$transaction(async (tx) => {
      // Atomically update only if claimStatus is not PAID
      // This ensures only one concurrent request can succeed
      const updateResult = await tx.insuranceClaim.updateMany({
        where: {
          id: claimId,
          claimStatus: {
            not: ClaimStatus.PAID,
          },
        },
        data: {
          claimStatus: ClaimStatus.PAID,
          paidAt: new Date(),
          paymentMethod: data.paymentMethod,
        },
      });

      // If no rows were updated, the claim was already paid (or changed status)
      if (updateResult.count === 0) {
        // Re-fetch to get current status for accurate error message
        const currentClaim = await tx.insuranceClaim.findUnique({
          where: { id: claimId },
          select: { claimStatus: true },
        });

        if (currentClaim?.claimStatus === ClaimStatus.PAID) {
          return Promise.reject(
            new AppError({
              status: httpCodes.BAD_REQUEST,
              code: "INSURANCE_CLAIM_ALREADY_PAID",
              message: "Insurance claim already paid",
            })
          );
        }
        return Promise.reject(
          new AppError({
            status: httpCodes.BAD_REQUEST,
            code: "INSURANCE_CLAIM_STATUS_CHANGED",
            message: "Insurance claim status changed",
          })
        );
      }

      // Mark all linked payments as FULLY_PAID and update paid amount
      const claimPayments = await tx.payment.findMany({
        where: { insuranceClaimId: claimId },
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
            paidAmount: payment.paidAmount.add(
              payment.insuranceAmount ?? new Decimal(0)
            ),
          },
        });
      }

      return { success: true };
    });

    // Invalidate cache after transaction commits successfully
    // Handle cache errors without affecting the DB transaction
    try {
      const clinicKey = insuranceClaim.clinicId ?? "ALL";
      const branchKey = insuranceClaim.branchId ?? "ALL";

      // Invalidate all insurance claim caches for this clinic/branch combination
      // Pattern matches: insurance-claims:${clinicId}:${branchId}:*
      await invalidateCache(`insurance-claims:${clinicKey}:${branchKey}:*`);

      // Also invalidate broader patterns to ensure all variants are cleared
      if (insuranceClaim.clinicId) {
        await invalidateCache(
          `insurance-claims:${insuranceClaim.clinicId}:ALL:*`
        );
      }
      if (insuranceClaim.branchId) {
        await invalidateCache(
          `insurance-claims:ALL:${insuranceClaim.branchId}:*`
        );
      }
      // Invalidate the most general pattern as fallback
      await invalidateCache("insurance-claims:ALL:ALL:*");
    } catch (cacheError) {
      // Log cache invalidation errors but don't fail the request
      logger.error("Failed to invalidate insurance claims cache", {
        error:
          cacheError instanceof Error ? cacheError.message : String(cacheError),
        claimId: insuranceClaim.id,
        clinicId: insuranceClaim.clinicId,
        branchId: insuranceClaim.branchId,
      });
    }

    return c.json(
      { success: "Insurance claim marked as paid" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    // Handle "already paid" error with appropriate status code
    if (
      error instanceof Error &&
      error.message === "Insurance claim already paid"
    ) {
      return c.json(
        { error: "Insurance claim already paid" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
