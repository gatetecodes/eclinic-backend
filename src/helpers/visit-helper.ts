import type { z } from "zod";
import {
  ClaimSource,
  EducationLevel,
  type Gender,
  InsuranceRelationshipType,
  PaymentMode,
  Prisma,
  Role,
  VisitStatus,
} from "../../generated/prisma/client";
import type {
  addPaymentMethodSchema,
  visitSchema,
} from "../api/v1/visits/visits.validation";
import { db } from "../database/db";
import type { User } from "../lib/auth";
import { Consultations, DefaultDepartments } from "../lib/constants";
import { logger } from "../lib/logger";
import {
  generatePatientId,
  parseDateString,
  parseNationalityFromPhoneNumber,
} from "../lib/utils";
import { invalidateCache } from "../services/redis.service";
import {
  createClaimForVisit,
  retryOnClaimNumberConflict,
} from "./claim-helper";
import { summarizeVisitBilling } from "./payments.helper";

type VisitSchemaType = z.infer<typeof visitSchema>;
type PaymentModeType = z.infer<typeof addPaymentMethodSchema>;

type IDoctor = {
  id: number;
  consultationFee: number | null;
  highestEducation: EducationLevel | null;
  role: Role;
  clinicalDepartments: { id: number; name: string }[];
};

function safelyParseDateOrUndefined(
  dateString?: string | null
): Date | undefined {
  if (!dateString) {
    return;
  }
  try {
    return parseDateString(dateString);
  } catch {
    return;
  }
}

async function findExistingPatient(
  patientData: VisitSchemaType["patient"],
  user: User,
  selectedPatientId?: number
): Promise<{ id: number } | null> {
  const clinicId = user.clinicId ?? user.clinic?.id;
  if (!clinicId) {
    return null;
  }

  // 0. If selectedPatientId is provided, use it directly
  if (selectedPatientId) {
    const patient = await db.patient.findFirst({
      where: { id: selectedPatientId, clinics: { some: { id: clinicId } } },
      select: { id: true },
    });
    if (patient) {
      return patient;
    }
  }

  if (patientData.isChild === true) {
    const parsedDob = safelyParseDateOrUndefined(patientData.dateOfBirth);
    const where: Prisma.PatientWhereInput = {
      AND: [
        { clinics: { some: { id: clinicId } } },
        { isChild: true },
        { guardianPhoneNumber: patientData.guardianPhoneNumber },
        { firstName: patientData.firstName },
        { lastName: patientData.lastName },
        ...(parsedDob ? [{ dateOfBirth: parsedDob }] : []),
      ] as Prisma.PatientWhereInput[],
    };
    return await db.patient.findFirst({ where, select: { id: true } });
  }

  const where: Prisma.PatientWhereInput = {
    AND: [
      { clinics: { some: { id: clinicId } } },
      { phoneNumber: patientData.phoneNumber },
      { firstName: patientData.firstName },
      { lastName: patientData.lastName },
    ],
  };
  return await db.patient.findFirst({ where, select: { id: true } });
}

async function updateMedicalInfoIfProvided(
  patientId: number,
  medicalInfo?: Prisma.JsonValue
): Promise<void> {
  if (!medicalInfo) {
    return;
  }
  await db.patient.update({
    where: { id: patientId },
    data: { medicalInfo },
  });
}

function deriveNationalityAndForeigner(
  primaryPhone: string | null | undefined,
  isAForeigner?: boolean | null
): { nationality: string | null; isForeigner: boolean | undefined } {
  const nationality = primaryPhone
    ? parseNationalityFromPhoneNumber(primaryPhone)
    : null;
  const isForeigner = primaryPhone
    ? nationality !== "Rwanda" || Boolean(isAForeigner)
    : undefined;
  return { nationality, isForeigner };
}
/**
 * Retrieves an existing patient or creates a new one if not found.
 * @param {VisitSchemaType['patient']} patientData - The patient data.
 * @param {UserType} user - The current user data.
 * @returns {Promise<number>} A promise that resolves to the patient's ID.
 */
export async function getOrCreatePatient(
  patientData: VisitSchemaType["patient"],
  user: User,
  selectedPatientId?: number
): Promise<{ patientId: number; isNewPatient: boolean }> {
  const existingPatient = await findExistingPatient(
    patientData,
    user,
    selectedPatientId
  );
  if (existingPatient) {
    await updateMedicalInfoIfProvided(
      existingPatient.id,
      patientData.medicalInfo
    );
    return { patientId: existingPatient.id, isNewPatient: false };
  }

  const patientId = generatePatientId();
  const primaryPhone =
    patientData.phoneNumber ?? patientData.guardianPhoneNumber ?? null;
  const { nationality, isForeigner } = deriveNationalityAndForeigner(
    primaryPhone,
    patientData.isAForeigner
  );

  const clinicId = user.clinicId ?? user.clinic?.id;
  const branchId = user.branchId ?? user.branch?.id;

  const newPatient = await db.patient.create({
    data: {
      ...patientData,
      patientId,
      dateOfBirth: parseDateString(patientData.dateOfBirth),
      gender: patientData.gender as Gender,
      nationality,
      ...(isForeigner !== undefined ? { isAForeigner: isForeigner } : {}),
      ...(patientData.foreignerRegion != null
        ? { foreignerRegion: patientData.foreignerRegion }
        : {}),
      clinics: clinicId ? { connect: { id: clinicId } } : undefined,
      branches: branchId ? { connect: { id: branchId } } : undefined,
    },
  });

  // Invalidate patient phone search cache for this clinic to avoid stale 404s
  if (clinicId) {
    const phoneNumbersToInvalidate = [
      patientData.phoneNumber,
      patientData.guardianPhoneNumber,
    ].filter(Boolean) as string[];
    await Promise.all(
      phoneNumbersToInvalidate.map((pn) =>
        invalidateCache(`patients:phone:${clinicId}:${pn}`)
      )
    );
  }

  return { patientId: newPatient.id, isNewPatient: true };
}

/**
 * Clears the clinic-scoped phone-search cache for a patient (both the patient's
 * own number and the guardian number, across every clinic they belong to). The
 * cached payload embeds the patient's latest insurance, so it must be cleared
 * whenever insurance changes to avoid reception seeing stale coverage.
 * @param {number} patientId - The ID of the patient.
 */
async function invalidatePatientPhoneSearchCache(
  patientId: number
): Promise<void> {
  // Best-effort: the insurance write has already committed, so a cache outage
  // must never fail the caller. Swallow any error from the lookup/eviction.
  try {
    const patient = await db.patient.findUnique({
      where: { id: patientId },
      select: {
        phoneNumber: true,
        guardianPhoneNumber: true,
        clinics: { select: { id: true } },
      },
    });
    if (!patient) {
      return;
    }
    const phones = [patient.phoneNumber, patient.guardianPhoneNumber].filter(
      Boolean
    ) as string[];
    await Promise.all(
      patient.clinics.flatMap((clinic) =>
        phones.map((pn) => invalidateCache(`patients:phone:${clinic.id}:${pn}`))
      )
    );
  } catch {
    /* cache invalidation is best-effort; never fail the insurance write */
  }
}

/**
 * Handles the insurance data for a patient.
 * @param {NonNullable<VisitSchemaType['insurance']>} insuranceData - The insurance data.
 * @param {number} patientId - The ID of the patient.
 * @returns {Promise<number>} A promise that resolves to the patient insurance ID.
 */
export async function handleInsurance(
  insuranceData: NonNullable<PaymentModeType["insurance"]>,
  patientId: number
): Promise<number> {
  if (!(insuranceData?.insuranceCompany && insuranceData?.insuranceNumber)) {
    return 0;
  }

  const insuranceCompanyId = await getOrCreateEntity(
    "insuranceCompany",
    insuranceData.insuranceCompany
  );
  let employerId: number | undefined;
  if (insuranceData.employer) {
    employerId = await getOrCreateEntity("employer", insuranceData.employer);
  }

  const existingInsurance = await db.patientInsurance.findFirst({
    where: {
      insuranceNumber: insuranceData.insuranceNumber,
      patientId,
    },
    select: { id: true },
  });

  if (existingInsurance) {
    // Keep the existing insurance record in sync with edited check-in details
    await db.patientInsurance.update({
      where: { id: existingInsurance.id },
      data: {
        coveragePercentage: Number.parseFloat(
          Number.parseFloat(insuranceData.coveragePercentage || "0").toFixed(2)
        ),
        insuranceCompanyId,
        employerId: employerId ?? null,
        relationshipType:
          (insuranceData.relationshipType as
            | "PRINCIPAL"
            | "SPOUSE"
            | "CHILD"
            | "OTHER") || "PRINCIPAL",
        principalName: insuranceData.principalName || null,
        principalPhoneNumber: insuranceData.principalPhoneNumber || null,
      },
    });
    await invalidatePatientPhoneSearchCache(patientId);
    return existingInsurance.id;
  }

  const newInsurance = await db.patientInsurance.create({
    data: {
      patientId,
      insuranceNumber: insuranceData.insuranceNumber,
      coveragePercentage: Number.parseFloat(
        Number.parseFloat(insuranceData.coveragePercentage || "0").toFixed(2)
      ),
      insuranceCompanyId,
      employerId,
      relationshipType:
        (insuranceData.relationshipType as InsuranceRelationshipType) ||
        InsuranceRelationshipType.PRINCIPAL,
      principalName: insuranceData.principalName || null,
      principalPhoneNumber: insuranceData.principalPhoneNumber || null,
    },
  });

  await invalidatePatientPhoneSearchCache(patientId);
  return newInsurance.id;
}

/**
 * Retrieves an existing insurance company or creates a new one if not found.
 * @param {string} name - The name of the insurance company.
 * @returns {Promise<number>} A promise that resolves to the insurance company's ID.
 */
async function getOrCreateEntity(
  type: "insuranceCompany" | "employer",
  name: string
): Promise<number> {
  if (type === "insuranceCompany") {
    const company = await db.insuranceCompany.findUnique({
      where: { companyName: name },
      select: { id: true },
    });

    if (company) {
      return company.id;
    }

    const newCompany = await db.insuranceCompany.create({
      data: { companyName: name },
    });

    return newCompany.id;
  }
  const employer = await db.employer.findUnique({
    where: { employerName: name },
    select: { id: true },
  });

  if (employer) {
    return employer.id;
  }

  const newEmployer = await db.employer.create({
    data: { employerName: name },
  });

  return newEmployer.id;
}

/**
 * Creates a new visit record in the database.
 * @param {Object} visitData - The data for creating a new visit.
 * @param {number} visitData.patientId - The ID of the patient.
 * @param {string} visitData.departmentId - The ID of the department.
 * @param {string | null} visitData.doctorId - The ID of the doctor (if any).
 * @param {PaymentMode} visitData.paymentMode - The payment mode for the visit.
 * @param {number} visitData.clinicId - The ID of the clinic.
 * @param {number} [visitData.patientInsuranceId] - The ID of the patient's insurance (if any).
 * @param {string} [visitData.notes] - Any additional notes for the visit.
 * @returns {Promise<any>} A promise that resolves to the created visit record.
 */
// export async function createVisit(
//   user: ExtendedUser,
//   visitData: {
//     patientId: number;
//     departmentId: string;
//     doctorId: string | null;
//     clinicId: number;
//     notes?: string;
//     isNewPatient: boolean;
//   }
// ) {
//   return await db.visit.create({
//     data: {
//       ...visitData,
//       departmentId: parseInt(visitData.departmentId),
//       doctorId: visitData.doctorId ? parseInt(visitData.doctorId) : null,
//       checkedInById: +user.id!
//     }
//   });
// }

export async function fetchDoctor(doctorId: number): Promise<IDoctor | null> {
  return await db.user.findUnique({
    where: { id: doctorId, role: Role.DOCTOR },
    select: {
      id: true,
      consultationFee: true,
      highestEducation: true,
      role: true,
      clinicalDepartments: { select: { id: true, name: true } },
    },
  });
}

export async function findConsultationProduct(
  doctor: IDoctor,
  department: { id: number; name: string },
  clinicId: number
) {
  if (doctor.role === Role.DOCTOR) {
    return await findDoctorConsultationProduct(department, clinicId);
  }
  if (doctor.role === Role.NURSE) {
    return findNurseConsultationProduct(
      doctor.highestEducation as EducationLevel,
      clinicId
    );
  }
}

async function findDoctorConsultationProduct(
  department: {
    id: number;
    name: string;
  },
  clinicId: number
) {
  const productName =
    department.name !== DefaultDepartments.MEDECINE_GENERAL
      ? Consultations.CONSULTATION_PAR_UN_SPECIALISTE
      : Consultations.CONSULTATION_PAR_UN_GENERALISTE_CHIRURGIEN_DENTISTE;

  return await findProductByName(productName, clinicId);
}

async function findNurseConsultationProduct(
  educationLevel: EducationLevel,
  clinicId: number
) {
  const productName =
    educationLevel === EducationLevel.A1
      ? Consultations.CONSULTATION_PAR_INFIRMIER_A1_DANS_UN_DISPENSAIRE
      : Consultations.CONSULTATION_PAR_INFIRMIER_A2_DANS_UN_DISPENSAIRE;

  return await findProductByName(productName, clinicId);
}

async function findProductByName(name: string, clinicId: number) {
  const searchTerms = name.split(" ").filter((term) => term.length > 2);

  const product = await db.product.findFirst({
    where: {
      OR: [
        { name: { equals: name, mode: Prisma.QueryMode.insensitive } },
        ...searchTerms.map((term) => ({
          name: { equals: term, mode: Prisma.QueryMode.insensitive },
        })),
      ],
    },
    select: {
      id: true,
      name: true,
      insurancePrices: {
        where: {
          OR: [{ clinicId }, { clinicId: null }],
        },
        select: {
          id: true,
          price: true,
          priceWithCo: true,
          clinicId: true,
        },
      },
      basePrice: true,
      unit: true,
      normalRange: true,
    },
  });
  return product;
}

export const computeConsultationFee = async (
  doctorId: number,
  department: { id: number; name: string },
  paymentMode: PaymentMode,
  clinicId: number
) => {
  try {
    const doctor = await fetchDoctor(doctorId);
    if (!doctor) {
      return { error: "Doctor not found" };
    }

    // const department = doctor.departments.find(
    //   (dept) => dept.id === departmentId
    // );
    // if (!department) return { error: 'Department not found' };

    // if (!doctor.consultationFee) return { error: 'Consultation fee not set' };

    const product = await findConsultationProduct(doctor, department, clinicId);
    if (product) {
      // Get clinic-specific prices with fallback
      const { getClinicProductPrice } = await import("./tariff-helpers");

      if (paymentMode === PaymentMode.INSURANCE) {
        // Find the first insurance price (clinic-specific or global)
        const insurancePrice =
          product.insurancePrices.find((ip) => ip.clinicId === clinicId) ||
          product.insurancePrices.find((ip) => ip.clinicId === null);

        if (insurancePrice) {
          return {
            product,
            fee: Number(insurancePrice.price),
          };
        }
      } else {
        const clinicPrices = await getClinicProductPrice(product.id, clinicId);
        const fee = clinicPrices.basePrice ?? product.basePrice;
        if (fee) {
          return {
            product,
            fee: Number(fee),
          };
        }
      }
    }
    return { product, fee: doctor.consultationFee };
  } catch (error) {
    logger.error("Error computing consultation fee:", { error });
    return { error: "Internal server error" };
  }
};

export const dischargeVisit = async ({
  user,
  visitId,
  hasPrescription = false,
}: {
  user: User;
  visitId: number;
  hasPrescription: boolean;
}) => {
  try {
    return await retryOnClaimNumberConflict(
      () =>
        db.$transaction(async (tx) => {
          // Fetch visit with all required relations
          const clinicId = user.clinicId ?? user.clinic?.id;
          const branchId = user.branchId ?? user.branch?.id;

          if (!(clinicId && branchId)) {
            return { error: "Clinic or branch not found" };
          }

          const visit = await tx.visit.findUnique({
            where: {
              id: visitId,
              clinicId,
              branchId,
            },
            include: {
              patient: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
              payments: {
                include: {
                  products: {
                    select: {
                      id: true,
                    },
                  },
                  discounts: {
                    select: {
                      amount: true,
                      approval: { select: { status: true } },
                    },
                  },
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
                },
              },
              prescriptions: true,
            },
          });

          if (!visit) {
            return { error: "Visit not found" };
          }

          // Discharge is gated on the PATIENT portion only. The insurance portion
          // does not block discharge — it becomes a claim that is reconciled
          // asynchronously after the patient has left.
          const billing = summarizeVisitBilling(visit.payments);

          logger.info("Discharge billing summary", { visitId, billing });
          if (!billing.canDischarge) {
            return {
              error: `Patient must settle their balance (${billing.patientOutstanding}) before discharge`,
              patientOutstanding: billing.patientOutstanding,
            };
          }

          // Update visit status based on prescription
          const updatedVisit = await tx.visit.update({
            where: { id: visitId },
            data: {
              status: hasPrescription
                ? VisitStatus.DISCHARGED_WITH_PRESCRIPTION
                : VisitStatus.DISCHARGED,
              endTime: new Date(),
            },
          });

          // Generate the insurance claim immediately so back-office reconciliation
          // can start the same day rather than waiting for the nightly cron.
          // Idempotent: only claims PAID insurance payments not yet attached.
          const insuranceClaim = await createClaimForVisit(
            tx,
            visitId,
            ClaimSource.DISCHARGE
          );

          return { ...updatedVisit, insuranceClaim, billing };
        }),
      "dischargeVisit"
    );
  } catch (error) {
    logger.error("Discharge visit error:", { error });
    return { error: "Failed to discharge visit" };
  }
};

export const getLabTechnicians = async (branchId: number) => {
  return await db.user.findMany({
    where: { role: Role.LAB_TECHNICIAN, branchId },
    select: { id: true, name: true },
  });
};

export const getCachier = async (branchId: number) => {
  return await db.user.findFirst({
    where: { role: Role.CASHIER, branchId },
    select: { id: true, name: true },
  });
};
