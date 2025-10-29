import { parse } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { httpCodes } from "@/lib/constants";
import { parseDateString } from "@/lib/utils";
import type {
  Gender,
  PaymentMode,
  Prisma,
  Visit,
} from "../../../../../generated/prisma";
import {
  ActivityType,
  PaymentType,
  Role,
  VisitStatus,
} from "../../../../../generated/prisma";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { buildQueryOptions } from "../../../../helpers/query-helper";
import { createPaymentForProducts } from "../../../../helpers/tariff-helpers";
import {
  dischargeVisit as dischargeVisitHelper,
  getCachier,
  getOrCreatePatient,
} from "../../../../helpers/visit-helper";
import {
  invalidateDashboardRelatedCaches,
  invalidatePaymentRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../../lib/cache-utils";
import { searchParamsSchema } from "../../../../lib/common-validation";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../../services/redis.service";
import {
  consultationNoteSchema,
  editChiefComplaintSchema,
  type finalizeVisitSchema,
  type IUpdateInitialCheckIn,
  initialCheckInSchema,
  preConsultationSchema,
  updateVisitStatusSchema,
} from "../visits.validation";

export const createInitialCheckIn = async (c: Context) => {
  try {
    const user = c.get("user");
    const parsed = initialCheckInSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const {
      patient,
      basicTriage,
      departmentId,
      priority,
      chiefComplaint,
      isLabOnly,
    } = parsed.data;

    const { patientId, isNewPatient } = await getOrCreatePatient(patient, user);

    const visit = await db.visit.create({
      data: {
        patient: { connect: { id: patientId } },
        chiefComplaint,
        department: { connect: { id: Number.parseInt(departmentId, 10) } },
        status: VisitStatus.CHECKED_IN,
        priority,
        basicTriage: basicTriage as unknown as Prisma.InputJsonValue,
        isNewPatient,
        clinic: { connect: { id: user.clinicId } },
        branch: { connect: { id: user.branchId } },
        checkedInBy: { connect: { id: Number(user.id) } },
        isLabOnly,
        requiresConsultation: !isLabOnly,
      },
      include: { patient: true, department: true },
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: visit.id,
    });
    await invalidateDashboardRelatedCaches(user.clinicId);

    return c.json(
      { success: "Patient checked in successfully", visit },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to check in patient" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * UPDATE INITIAL CHECK-IN
 * @param c
 * @returns
 */

export const updateInitialCheckIn = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const {
      patient,
      basicTriage,
      departmentId,
      priority,
      chiefComplaint,
      isLabOnly,
    } = data as IUpdateInitialCheckIn;

    // Check if visit exists and belongs to the user's clinic
    const existingVisit = await db.visit.findFirst({
      where: {
        id: visitId,
        clinicId: user.clinicId,
      },
      include: {
        patient: true,
      },
    });

    if (!existingVisit) {
      return c.json(
        { error: "Visit not found or access denied" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      !(
        [VisitStatus.CHECKED_IN, VisitStatus.TRIAGE_COMPLETED] as VisitStatus[]
      ).includes(existingVisit.status)
    ) {
      // Only allow editing if visit is still in CHECKED_IN status
      return c.json(
        { error: "Only checked-in and triage completed visits can be edited" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Update patient information
    const updatedPatient = await db.patient.update({
      where: { id: existingVisit.patientId },
      data: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: parseDateString(patient.dateOfBirth),
        gender: patient.gender as Gender,
        isChild: patient.isChild,
        phoneNumber: patient.phoneNumber,
        guardianPhoneNumber: patient.guardianPhoneNumber,
        isAForeigner: patient.isAForeigner,
      },
    });

    // Update visit
    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        chiefComplaint,
        department: departmentId
          ? { connect: { id: +departmentId } }
          : { disconnect: true },
        priority,
        basicTriage,
        isLabOnly: !!isLabOnly,
        requiresConsultation: !isLabOnly,
      },
      include: {
        patient: true,
        department: true,
      },
    });

    // Log activity
    await logActivity({
      userId: Number(user.id),
      visitId,
      action: `Initial check-in updated for ${updatedPatient.firstName} ${updatedPatient.lastName} by ${user?.name}`,
      type: ActivityType.STATUS_UPDATE,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json(
      { success: "Initial check-in updated successfully", visit: updatedVisit },
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

export const addPreConsultation = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = preConsultationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const {
      vitals,
      doctorId,
      notes,
      consultationProductIds,
      requiresConsultation,
    } = parsed.data;

    const result = await db.$transaction(async (tx) => {
      const updatedVisit = await tx.visit.update({
        data: {
          doctor: { connect: { id: Number.parseInt(doctorId, 10) } },
          notes,
          status: VisitStatus.TRIAGE_COMPLETED,
          consultations: consultationProductIds
            ? {
                connect: consultationProductIds.map((pid) => ({
                  id: Number.parseInt(pid, 10),
                })),
              }
            : undefined,
          requiresConsultation,
        },
        where: { id: visitId },
        select: {
          id: true,
          doctorId: true,
          basicTriage: true,
          patientId: true,
        },
      });

      const updatedPatient = await tx.patient.update({
        data: {
          medicalInfo: {
            ...(vitals as unknown as Prisma.InputJsonObject),
            ...(updatedVisit.basicTriage as Prisma.InputJsonObject),
          },
        },
        where: { id: updatedVisit.patientId },
        select: { firstName: true, lastName: true },
      });

      return { updatedVisit, updatedPatient };
    });

    if (result.updatedVisit.doctorId) {
      await logActivity({
        userId: Number(user.id),
        visitId,
        type: ActivityType.STATUS_UPDATE,
        action: `New patient check in for pre-consultation by ${user.name}`,
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({
      success: "Pre-consultation details updated",
      data: result,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to update pre-consultation details" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * EDIT PRE-CONSULTATION
 * @param c
 * @returns
 */

export const editPreConsultation = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const {
      vitals,
      doctorId,
      notes,
      requiresConsultation,
      consultationProductIds,
    } = data as z.infer<typeof preConsultationSchema>;

    // Check if visit exists and belongs to the user's clinic
    const existingVisit = await db.visit.findFirst({
      where: {
        id: visitId,
        clinicId: user.clinicId,
        branchId: user.branchId,
      },
      include: {
        patient: true,
      },
    });

    if (!existingVisit) {
      return c.json(
        { error: "Visit not found or access denied" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (existingVisit.status === VisitStatus.CHECKED_IN) {
      // Check if visit is in appropriate status for editing pre-consultation
      return c.json(
        {
          error:
            "Please complete initial triage before editing pre-consultation details",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (existingVisit.isLabOnly) {
      return c.json(
        {
          error:
            "Pre-consultation details are not applicable for lab-only visits.",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatePatientAndVisit = await db.$transaction(async (tx) => {
      // Update visit with new pre-consultation data
      const updatedVisit = await tx.visit.update({
        data: {
          doctor: { connect: { id: +doctorId } },
          notes,
          consultations: {
            set: [], // Clear existing consultations
            connect: consultationProductIds?.map((pid) => ({ id: +pid })),
          },
          requiresConsultation,
        },
        where: {
          id: visitId,
        },
      });

      // Update patient's medical info with new vitals
      const updatedPatient = await tx.patient.update({
        data: {
          medicalInfo: {
            ...vitals,
            ...(updatedVisit.basicTriage as Prisma.InputJsonObject),
          },
        },
        where: {
          id: existingVisit.patientId,
        },
      });

      return { updatedPatient, updatedVisit };
    });

    // Log activity
    await logActivity({
      userId: Number(user.id),
      visitId,
      action: `Pre-consultation details updated for ${updatePatientAndVisit.updatedPatient.firstName} ${updatePatientAndVisit.updatedPatient.lastName} by ${user?.name}`,
      type: ActivityType.STATUS_UPDATE,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json(
      {
        success: "Pre-consultation details updated successfully",
        data: updatePatientAndVisit,
      },
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

export const addPaymentMethod = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const { paymentMode, insurance } = data as {
      paymentMode: string;
      insurance?: Record<string, unknown>;
    };

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        requiresConsultation: true,
        patientId: true,
        doctorId: true,
        departmentId: true,
        patient: { select: { firstName: true, lastName: true } },
        consultations: { select: { id: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (!(visit.doctorId || visit.departmentId)) {
      return c.json(
        { error: "Visit missing doctor or department" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    let patientInsuranceId: number | undefined;
    if (insurance && Object.keys(insurance).length > 0) {
      const { handleInsurance } = await import(
        "../../../../helpers/visit-helper"
      );
      patientInsuranceId = await handleInsurance(
        insurance as unknown as NonNullable<unknown>,
        visit.patientId
      );
    }

    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        paymentMode: paymentMode as PaymentMode,
        patientInsuranceId,
      },
      include: { consultations: true },
    });

    if (visit.requiresConsultation) {
      const consultationProductIds = updatedVisit.consultations.map(
        (cons: { id: number }) => cons.id
      );
      try {
        const consultationPayment = await createPaymentForProducts(
          consultationProductIds,
          updatedVisit.id,
          PaymentType.CONSULTATION
        );
        const paymentCashier = await getCachier(user.branchId);
        if (paymentCashier) {
          await db.notification.create({
            data: {
              userId: paymentCashier.id,
              title: "New payment bill",
              message: `New ${String(consultationPayment.paymentType)} payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
              type: "NEW_PAYMENT_BILL",
              visitId,
            },
          });
        }
      } catch (error) {
        const message = (error as Error).message;
        return c.json(
          { error: message },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.PAYMENT,
      action: `${user.name} updated visit with payment mode`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    await invalidatePaymentRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({
      success: "Payment method added successfully",
      data: updatedVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const listVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const cacheKey = `visits:${user.clinicId}:${user.branchId}:${user.role}:${JSON.stringify(
      params
    )}`;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const queryOptions = buildQueryOptions<Visit>(params);
        const { where, orderBy, ...restOptions } = queryOptions;

        // Role-based status visibility
        let roleStatusFilter: Prisma.VisitWhereInput["status"] | undefined;
        if (user.role === Role.LAB_TECHNICIAN) {
          roleStatusFilter = VisitStatus.PENDING_TESTS;
        } else if (user.role === Role.DOCTOR) {
          roleStatusFilter = {
            in: [
              VisitStatus.CHECKED_IN,
              VisitStatus.TRIAGE_COMPLETED,
              VisitStatus.IN_CONSULTATION,
              VisitStatus.PENDING_TESTS,
              VisitStatus.RESULTS_READY,
              VisitStatus.FINALIZED,
              VisitStatus.DISCHARGED,
              VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
              VisitStatus.ADMITTED,
            ],
          } as Prisma.VisitWhereInput["status"]; // explicit to satisfy types
        } else if (user.role === Role.NURSE) {
          roleStatusFilter = {
            in: [
              VisitStatus.CHECKED_IN,
              VisitStatus.TRIAGE_COMPLETED,
              VisitStatus.IN_CONSULTATION,
              VisitStatus.PENDING_TESTS,
              VisitStatus.RESULTS_READY,
              VisitStatus.DISCHARGED,
              VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
              VisitStatus.FINALIZED,
            ],
          } as Prisma.VisitWhereInput["status"]; // explicit to satisfy types
        }

        const statusFilter: Prisma.VisitWhereInput["status"] | undefined =
          roleStatusFilter
            ? roleStatusFilter
            : (where?.status as Prisma.VisitWhereInput["status"] | undefined);

        const whereInput: Prisma.VisitWhereInput = {
          ...where,
          status: statusFilter,
        };
        if (user.role !== Role.SUPER_ADMIN) {
          whereInput.clinicId = user.clinicId;
          whereInput.branchId = user.branchId;
        }

        const visits = await db.visit.findMany({
          ...restOptions,
          where: whereInput,
          orderBy: orderBy as Prisma.VisitOrderByWithRelationInput,
          include: {
            clinic: { select: { id: true, name: true } },
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                dateOfBirth: true,
                gender: true,
                address: true,
                email: true,
              },
            },
            department: { select: { id: true, name: true } },
            doctor: { select: { id: true, name: true } },
            patientInsurance: {
              select: {
                id: true,
                insuranceNumber: true,
                insuranceCompany: { select: { companyName: true } },
              },
            },
            consultation: { select: { id: true, name: true } },
            consultations: { select: { id: true, name: true } },
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
            spectaclePrescription: {
              select: {
                id: true,
                rightEye: true,
                leftEye: true,
                interpupillaryDistance: true,
                lensType: true,
              },
            },
          },
        });

        const totalCount = await db.visit.count({ where: whereInput });
        const pageCount = restOptions.take
          ? Math.ceil(totalCount / restOptions.take)
          : 0;
        return { data: visits, totalCount, pageCount };
      },
      DEFAULT_CACHE_TTL.SHORT
    );

    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getVisitById = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const cacheKey = `visit:${visitId}`;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const visit = await db.visit.findUnique({
          where: { id: visitId },
          select: {
            id: true,
            status: true,
            paymentMode: true,
            consultationNote: true,
            transferReason: true,
            chiefComplaint: true,
            basicTriage: true,
            diagnosis: true,
            examConclusions: true,
            treatmentComments: true,
            followUpDate: true,
            updatedAt: true,
            clinicId: true,
            branchId: true,
            clinic: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                isChild: true,
                dateOfBirth: true,
                gender: true,
                phoneNumber: true,
                nationality: true,
                isAForeigner: true,
                address: true,
                medicalInfo: true,
                email: true,
                guardianPhoneNumber: true,
              },
            },
            doctor: { select: { id: true, name: true } },
            department: { select: { id: true, name: true } },
            patientInsurance: {
              select: {
                id: true,
                coveragePercentage: true,
                insuranceNumber: true,
                employer: { select: { id: true, employerName: true } },
                insuranceCompany: { select: { companyName: true } },
              },
            },
            payments: {
              select: {
                id: true,
                amount: true,
                insuranceAmount: true,
                patientAmount: true,
                paymentType: true,
                paymentStatus: true,
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
            spectaclePrescription: {
              select: {
                id: true,
                rightEye: true,
                leftEye: true,
                interpupillaryDistance: true,
                lensType: true,
              },
            },
            exams: {
              select: {
                id: true,
                name: true,
                createdAt: true,
                products: { select: { id: true, name: true } },
                results: {
                  select: {
                    id: true,
                    examDate: true,
                    results: true,
                    notes: true,
                    createdAt: true,
                    createdBy: { select: { id: true, name: true } },
                  },
                },
              },
            },
            treatments: true,
          },
        });

        if (!visit) {
          return null;
        }
        return { data: visit };
      },
      DEFAULT_CACHE_TTL.SHORT
    );

    if (!data?.data) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const visit = data.data as {
      clinicId: number;
      branchId: number;
    } & Record<string, unknown>;

    const notSuper = user.role !== Role.SUPER_ADMIN;
    if (notSuper && visit.clinicId !== user.clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    if (notSuper && visit.branchId !== user.branchId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json(data);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPatientVisits = async (c: Context) => {
  try {
    const { patientId } = c.get("validatedParam");
    const pid = Number.parseInt(patientId, 10);
    const visits = await db.visit.findMany({
      where: { patientId: pid },
      include: {
        patient: true,
        department: true,
        doctor: true,
        exams: {
          include: { products: { include: { tests: true } }, results: true },
        },
        examResults: { include: { createdBy: true } },
        prescriptions: { include: { items: true } },
        patientInsurance: {
          include: { employer: true, insuranceCompany: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    return c.json({ data: visits });
  } catch (_error) {
    return c.json(
      { error: "Failed to fetch patient visits" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createConsultationNote = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = consultationNoteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.update({
      where: { id: visitId },
      data: { consultationNote: parsed.data.consultationNote },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    return c.json(
      { success: true, message: "Consultation note added successfully", visit },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to add consultation note" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editConsultationNote = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = consultationNoteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.update({
      where: { id: visitId },
      data: { consultationNote: parsed.data.consultationNote },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    return c.json(
      {
        success: true,
        message: "Consultation note updated successfully",
        visit,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to update consultation note" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const finalizeVisit = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson") as z.infer<typeof finalizeVisitSchema>;
    const { diagnosis, examConclusions, treatmentComments, followUpDate } =
      data;

    let parsedFollowUpDate: Date | undefined;
    if (followUpDate) {
      const d = parse(followUpDate, "dd/MM/yyyy", new Date());
      if (Number.isNaN(d.getTime())) {
        return c.json(
          { error: "Invalid follow-up date format. Please use DD/MM/YYYY" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
      parsedFollowUpDate = d;
    }

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        status: true,
        doctor: { select: { id: true, name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const currentUserId = Number(user.id);
    if (visit.doctor?.id !== currentUserId) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const cannotFinalizeStatuses: Array<"CHECKED_IN" | "TRIAGE_COMPLETED"> = [
      VisitStatus.CHECKED_IN,
      VisitStatus.TRIAGE_COMPLETED,
    ];
    if (
      cannotFinalizeStatuses.includes(
        visit.status as (typeof cannotFinalizeStatuses)[number]
      )
    ) {
      return c.json(
        { error: "Visit cannot be finalized at this stage" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        diagnosis,
        examConclusions,
        treatmentComments,
        followUpDate: parsedFollowUpDate,
        status: VisitStatus.FINALIZED,
      },
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    return c.json({
      success: "Visit finalized successfully",
      visit: updatedVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const dischargeVisit = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        patient: { select: { firstName: true, lastName: true } },
        patientInsurance: {
          select: { insuranceCompany: { select: { companyName: true } } },
        },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const visitPrescription = await db.prescription.findFirst({
      where: { visitId },
      select: { id: true },
    });
    const result = await dischargeVisitHelper({
      user,
      visitId,
      hasPrescription: Boolean(visitPrescription),
    });

    if ((result as { error?: string }).error) {
      return c.json(
        { error: (result as { error: string }).error },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Log insurance claim creation activity if applicable
    if (visit.patientInsurance?.insuranceCompany?.companyName) {
      await logActivity({
        userId: Number(user.id),
        visitId,
        type: ActivityType.INSURANCE_CLAIM,
        action: `Insurance claim created for ${visit.patient.firstName} ${visit.patient.lastName}. Insurance company: ${visit.patientInsurance.insuranceCompany.companyName}`,
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({ success: "Visit discharged successfully", result });
  } catch (_error) {
    return c.json(
      { error: "Failed to discharge visit" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateVisitStatus = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = updateVisitStatusSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { status } = parsed.data;

    const updated = await db.visit.update({
      where: { id: visitId },
      data: { status },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
      doctorId: updated.doctorId || undefined,
    });
    return c.json({
      success: "Visit status updated successfully",
      visit: updated,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to update visit status" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
export const editChiefComplaint = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = editChiefComplaintSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: { id: true, chiefComplaint: true, doctorId: true },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (visit.doctorId !== Number(user.id)) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const updated = await db.visit.update({
      where: { id: visitId },
      data: { chiefComplaint: parsed.data.chiefComplaint },
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json(
      {
        success: true,
        message: "Chief complaint updated successfully",
        visit: updated,
      },
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
