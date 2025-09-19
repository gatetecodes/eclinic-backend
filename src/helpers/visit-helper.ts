import { parse } from "date-fns";
import type { z } from "zod";
import {
  EducationLevel,
  type Gender,
  type Payment,
  PaymentMode,
  PaymentStatus,
  Prisma,
  Role,
  VisitStatus,
} from "../../generated/prisma";
import type {
  addPaymentMethodSchema,
  visitSchema,
} from "../api/v1/visits/visits.validation";
import { db } from "../database/db";
import { createAutomaticClaim } from "../helpers/claim-helper";
import type { User } from "../lib/auth";
import { Consultations, DefaultDepartments } from "../lib/constants";
import { logger } from "../lib/logger";
import {
  generatePatientId,
  parseNationalityFromPhoneNumber,
} from "../lib/utils";

type VisitSchemaType = z.infer<typeof visitSchema>;
type PaymentModeType = z.infer<typeof addPaymentMethodSchema>;

type IDoctor = {
  id: number;
  consultationFee: number | null;
  highestEducation: EducationLevel | null;
  role: Role;
  clinicalDepartments: { id: number; name: string }[];
};
/**
 * Retrieves an existing patient or creates a new one if not found.
 * @param {VisitSchemaType['patient']} patientData - The patient data.
 * @param {UserType} user - The current user data.
 * @returns {Promise<number>} A promise that resolves to the patient's ID.
 */
export async function getOrCreatePatient(
  patientData: VisitSchemaType["patient"],
  user: User
): Promise<{ patientId: number; isNewPatient: boolean }> {
  const existingPatient = await db.patient.findFirst({
    where: {
      AND: [
        { phoneNumber: patientData.phoneNumber },
        { lastName: patientData.lastName },
        { firstName: patientData.firstName },
      ],
    },
    select: { id: true },
  });

  if (existingPatient) {
    //Update medical info if it is provided
    if (patientData.medicalInfo) {
      await db.patient.update({
        where: { id: existingPatient.id },
        data: {
          medicalInfo: patientData.medicalInfo,
        },
      });
    }
    return { patientId: existingPatient.id, isNewPatient: false };
  }

  const patientId = generatePatientId();

  const primaryPhone =
    patientData.phoneNumber ?? patientData.guardianPhoneNumber ?? null;
  const nationality = primaryPhone
    ? parseNationalityFromPhoneNumber(primaryPhone)
    : null;
  const isForeigner = primaryPhone
    ? nationality !== "Rwanda" || Boolean(patientData.isAForeigner)
    : undefined;

  const newPatient = await db.patient.create({
    data: {
      ...patientData,
      patientId,
      dateOfBirth: parseDateString(patientData.dateOfBirth),
      gender: patientData.gender as Gender,
      nationality,
      ...(isForeigner !== undefined ? { isAForeigner: isForeigner } : {}),
      clinics: { connect: { id: user?.clinic.id } },
      branches: { connect: { id: user?.branch.id } },
    },
  });

  return { patientId: newPatient.id, isNewPatient: true };
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
  if (!(insuranceData && "insuranceCompany" in insuranceData)) {
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

  const existingInsurance = await db.patientInsurance.findUnique({
    where: { insuranceNumber: insuranceData.insuranceNumber },
    select: { id: true },
  });

  if (existingInsurance) {
    return existingInsurance.id;
  }

  const newInsurance = await db.patientInsurance.create({
    data: {
      patientId,
      insuranceNumber: insuranceData.insuranceNumber,
      coveragePercentage: Number.parseFloat(
        Number.parseFloat(insuranceData.coveragePercentage).toFixed(2)
      ),
      insuranceCompanyId,
      employerId,
    },
  });

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
  department: { id: number; name: string }
) {
  if (doctor.role === Role.DOCTOR) {
    return await findDoctorConsultationProduct(department);
  }
  if (doctor.role === Role.NURSE) {
    return findNurseConsultationProduct(
      doctor.highestEducation as EducationLevel
    );
  }
}

async function findDoctorConsultationProduct(department: {
  id: number;
  name: string;
}) {
  const productName =
    department.name !== DefaultDepartments.MEDECINE_GENERAL
      ? Consultations.CONSULTATION_PAR_UN_SPECIALISTE
      : Consultations.CONSULTATION_PAR_UN_GENERALISTE_CHIRURGIEN_DENTISTE;

  return await findProductByName(productName);
}

async function findNurseConsultationProduct(educationLevel: EducationLevel) {
  const productName =
    educationLevel === EducationLevel.A1
      ? Consultations.CONSULTATION_PAR_INFIRMIER_A1_DANS_UN_DISPENSAIRE
      : Consultations.CONSULTATION_PAR_INFIRMIER_A2_DANS_UN_DISPENSAIRE;

  return await findProductByName(productName);
}

async function findProductByName(name: string) {
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
      insurancePrices: { select: { id: true, price: true, priceWithCo: true } },
      basePrice: true,
      unit: true,
      normalRange: true,
    },
  });
  return product;
}

function parseDateString(dateString: string): Date {
  const formats = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"];

  for (const format of formats) {
    const date = parse(dateString, format, new Date());
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  throw new Error(`Invalid date format: ${dateString}`);
}

export const computeConsultationFee = async (
  doctorId: number,
  department: { id: number; name: string },
  paymentMode: PaymentMode
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

    const product = await findConsultationProduct(doctor, department);
    if (product) {
      return {
        product,
        fee:
          paymentMode === PaymentMode.INSURANCE
            ? product.insurancePrices[0].price
            : product.basePrice,
      };
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
    return await db.$transaction(async (tx) => {
      // Fetch visit with all required relations
      const visit = await tx.visit.findUnique({
        where: {
          id: visitId,
          clinicId: user.clinic.id,
          branchId: user.branch.id,
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

      // Verify all payments are completed
      const hasUnpaidPayments = visit.payments.some(
        (payment: Payment) => payment.paymentStatus === PaymentStatus.PENDING
      );

      logger.info("Has unpaid payments", { hasUnpaidPayments });
      if (hasUnpaidPayments) {
        return { error: "Cannot discharge visit with pending payments" };
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

      // Create insurance claim if applicable
      if (
        visit.paymentMode === PaymentMode.INSURANCE &&
        visit.patientInsurance
      ) {
        await createAutomaticClaim(visit);

        // If visit has prescriptions, automatically attach them as claim documents
        // if (visit.prescriptions.length > 0) {
        //   await Promise.all(
        //     visit.prescriptions.map(async (prescription) => {
        //       await tx.insuranceClaimDocument.create({
        //         data: {
        //           claim: { connect: { id: claim.id } },
        //           documentType: 'PRESCRIPTION',
        //           documentUrl: prescription.documentUrl // Assuming this exists
        //         }
        //       });
        //     })
        //   );
        // }
      }

      return updatedVisit;
    });
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
