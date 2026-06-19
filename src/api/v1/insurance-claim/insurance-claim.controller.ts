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
import { validateClaim } from "../../../helpers/claim-validation";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { invalidateInsuranceClaimRelatedCaches } from "../../../lib/cache-utils";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { getScope } from "../../../lib/request-scope";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";

function visitPatientWhereFromSearch(patient: string): Prisma.VisitWhereInput {
  const decodedPatient = patient.replace(/\+/g, " ");
  const searchTerms = decodedPatient
    .split(" ")
    .filter((term) => term.length > 0);
  if (searchTerms.length === 0) {
    return {};
  }

  const queryMode: Prisma.QueryMode = "insensitive";

  if (searchTerms.length === 1) {
    const term = searchTerms[0] as string;
    return {
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    };
  }

  const multiTermConditions: Prisma.VisitWhereInput[] = searchTerms.map(
    (term) => ({
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    })
  );
  return { AND: multiTermConditions };
}

function insuranceClaimListExtraWhere(args: {
  doctorId?: string;
  patient?: string;
  claimStatus?: string;
  deductedOnly?: boolean;
}): Prisma.InsuranceClaimWhereInput {
  const clauses: Prisma.InsuranceClaimWhereInput[] = [];
  if (args.deductedOnly) {
    clauses.push({ deductedAmount: { gt: 0 } });
  }
  if (args.claimStatus) {
    const statuses = args.claimStatus
      .split(".")
      .filter(Boolean) as ClaimStatus[];
    if (statuses.length > 0) {
      clauses.push({ claimStatus: { in: statuses } });
    }
  }
  const visitClauses: Prisma.VisitWhereInput[] = [];
  if (args.doctorId) {
    visitClauses.push({ doctorId: Number(args.doctorId) });
  }
  if (args.patient) {
    const patientWhere = visitPatientWhereFromSearch(args.patient);
    if (Object.keys(patientWhere).length > 0) {
      visitClauses.push(patientWhere);
    }
  }
  if (visitClauses.length > 0) {
    clauses.push({ visit: { AND: visitClauses } });
  }
  if (clauses.length === 0) {
    return {};
  }
  if (clauses.length === 1) {
    return clauses[0] as Prisma.InsuranceClaimWhereInput;
  }
  return { AND: clauses };
}

function mergeInsuranceClaimWhere(
  base: Prisma.InsuranceClaimWhereInput,
  extra: Prisma.InsuranceClaimWhereInput
): Prisma.InsuranceClaimWhereInput {
  if (Object.keys(extra).length === 0) {
    return base;
  }
  if (Object.keys(base).length === 0) {
    return extra;
  }
  return { AND: [base, extra] };
}

export const getInsuranceClaims = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const { doctorId, patient, claimStatus, deductedOnly, ...restForQuery } =
      params;
    const queryOptions = buildQueryOptions<InsuranceClaim>(restForQuery, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });
    const { where: baseWhere, orderBy, ...restOptions } = queryOptions;
    const where = mergeInsuranceClaimWhere(
      baseWhere as Prisma.InsuranceClaimWhereInput,
      insuranceClaimListExtraWhere({
        doctorId,
        patient,
        claimStatus,
        deductedOnly,
      })
    );
    const cacheKey = `insurance-claims:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;

    const insuranceClaimsData = await getCachedData(
      cacheKey,
      async () => {
        const claims = await db.insuranceClaim.findMany({
          where,
          orderBy: orderBy as Prisma.InsuranceClaimOrderByWithRelationInput,
          ...restOptions,
          include: {
            items: {
              select: {
                id: true,
                quantity: true,
                amount: true,
                insuranceAmount: true,
                itemStatus: true,
                product: {
                  select: {
                    name: true,
                    code: true,
                    unit: true,
                    icd11Code: true,
                    loincCode: true,
                    nationalTariffCode: true,
                  },
                },
              },
            },
            visit: {
              select: {
                id: true,
                doctorId: true,
                diagnosis: true,
                doctor: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
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
          where,
        });

        const stats = await db.insuranceClaim.groupBy({
          by: ["claimStatus"],
          where,
          _sum: {
            totalAmount: true,
            deductedAmount: true,
          },
          _count: true,
        });

        const companiesWithClaims = await db.insuranceClaim.findMany({
          where,
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
            const gross = Number(curr._sum.totalAmount || 0);
            const deduction = Number(curr._sum.deductedAmount || 0);
            acc[curr.claimStatus] = gross - deduction;
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

        const totalDeductedAmount = stats.reduce(
          (acc, curr) => acc + Number(curr._sum.deductedAmount || 0),
          0
        );

        return {
          data: claims,
          totalCount,
          pageCount,
          stats: {
            totalCompanies: uniqueCompanies.size,
            totalAmount: Object.values(totalAmounts).reduce((a, b) => a + b, 0),
            totalDeductedAmount,
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
      await invalidateInsuranceClaimRelatedCaches({
        clinicId: insuranceClaim.clinicId,
        branchId: insuranceClaim.branchId,
      });
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

export const recordInsuranceDeduction = async (c: Context) => {
  try {
    const claimId = Number.parseInt(c.req.param("claimId"), 10);
    const data = c.get("validatedJson");
    const user = c.get("user");

    const insuranceClaim = await db.insuranceClaim.findUnique({
      where: {
        id: claimId,
        ...(typeof user.clinicId === "number"
          ? { clinicId: user.clinicId }
          : {}),
      },
      select: { id: true, clinicId: true, branchId: true, totalAmount: true },
    });

    if (!insuranceClaim) {
      return c.json(
        { error: "Insurance claim not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (data.deductedAmount > Number(insuranceClaim.totalAmount)) {
      return c.json(
        { error: "Deducted amount cannot exceed total claim amount" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await db.insuranceClaim.update({
      where: { id: insuranceClaim.id },
      data: {
        deductedAmount: data.deductedAmount,
        deductionReason: data.deductionReason,
      },
    });

    try {
      await invalidateInsuranceClaimRelatedCaches({
        clinicId: insuranceClaim.clinicId,
        branchId: insuranceClaim.branchId,
      });
    } catch {
      // Ignore cache errors
    }

    return c.json(
      { success: "Insurance deduction recorded successfully" },
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

// Mark a queued (PENDING) claim as submitted to the insurer, stamping the
// submission date. This is the back-office reconciliation action that moves a
// claim out of the "to submit" queue and starts its aging clock.
export const markInsuranceClaimAsSubmitted = async (c: Context) => {
  try {
    const claimId = Number.parseInt(c.req.param("claimId"), 10);
    if (Number.isNaN(claimId)) {
      return c.json(
        { error: "Invalid insurance claim id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const user = c.get("user");

    const insuranceClaim = await db.insuranceClaim.findUnique({
      where: {
        id: claimId,
        ...(typeof user.clinicId === "number"
          ? { clinicId: user.clinicId }
          : {}),
      },
      select: { id: true, clinicId: true, branchId: true, claimStatus: true },
    });

    if (!insuranceClaim) {
      return c.json(
        { error: "Insurance claim not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Only a queued (PENDING) claim can be submitted; ignore anything already
    // submitted or further along to keep the action idempotent.
    const updateResult = await db.insuranceClaim.updateMany({
      where: { id: claimId, claimStatus: ClaimStatus.PENDING },
      data: {
        claimStatus: ClaimStatus.SUBMITTED,
        submissionDate: new Date(),
      },
    });

    if (updateResult.count === 0) {
      return c.json(
        { error: "Only pending claims can be marked as submitted" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    try {
      await invalidateInsuranceClaimRelatedCaches({
        clinicId: insuranceClaim.clinicId,
        branchId: insuranceClaim.branchId,
      });
    } catch {
      // Ignore cache errors
    }

    return c.json(
      { success: "Insurance claim marked as submitted" },
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

export const validateInsuranceClaim = async (c: Context) => {
  try {
    const claimId = Number.parseInt(c.req.param("claimId"), 10);
    if (Number.isNaN(claimId)) {
      return c.json(
        { error: "Invalid insurance claim id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const user = c.get("user");

    const claim = await db.insuranceClaim.findUnique({
      where: {
        id: claimId,
        ...(typeof user.clinicId === "number"
          ? { clinicId: user.clinicId }
          : {}),
      },
      select: {
        documents: { select: { id: true } },
        patientInsurance: {
          select: {
            insuranceCompanyId: true,
            startDate: true,
            endDate: true,
          },
        },
        visit: { select: { diagnosis: true } },
        items: {
          select: {
            product: {
              select: {
                name: true,
                nationalTariffCode: true,
                icd11Code: true,
                insurancePrices: { select: { insuranceCompanyId: true } },
              },
            },
          },
        },
      },
    });

    if (!claim) {
      return c.json(
        { error: "Insurance claim not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    return c.json(
      { data: validateClaim(claim) },
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
