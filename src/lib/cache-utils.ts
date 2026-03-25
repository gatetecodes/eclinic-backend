import { format } from "date-fns";
import { db } from "../database/db";
import {
  CACHE_KEYS,
  invalidateCache,
  invalidateDashboardCache,
} from "../services/redis.service";

/**
 * Invalidates cache related to visits when visit data changes
 * @param {number} clinicId - The clinic ID
 * @param {number} visitId - The visit ID (optional)
 * @param {number} patientId - The patient ID (optional)
 * @param {number} doctorId - The doctor ID (optional)
 */
export async function invalidateVisitRelatedCaches({
  clinicId,
  branchId,
  visitId,
  patientId,
  doctorId,
}: {
  clinicId: number;
  branchId?: number;
  visitId?: number;
  patientId?: number;
  doctorId?: number;
}) {
  const cacheInvalidationPromises = [
    // Invalidate all visit listings regardless of role and params
    invalidateCache(`${CACHE_KEYS.VISITS}:${clinicId}:${branchId}:*`),
    // Invalidate dashboard stats
    invalidateDashboardRelatedCaches(clinicId),
  ];

  // If we have a doctor ID, invalidate doctor-specific caches
  if (doctorId) {
    cacheInvalidationPromises.push(
      invalidateCache(
        `${CACHE_KEYS.APPOINTMENTS.DOCTOR_APPOINTMENTS}:${doctorId}:*`
      ),
      invalidateCache(
        `${CACHE_KEYS.APPOINTMENTS.DOCTOR_AVAILABILITY}:${doctorId}:*`
      )
    );
  }

  // If we have a patient ID, invalidate patient-specific caches
  if (patientId) {
    const patient = await db.patient.findUnique({
      where: { id: patientId },
      select: { phoneNumber: true },
    });

    if (patient) {
      cacheInvalidationPromises.push(
        invalidateCache(`${CACHE_KEYS.PATIENTS}:phone:${patient.phoneNumber}`)
      );
    }
  }

  // Ensure we invalidate any visit-specific caches
  if (visitId) {
    cacheInvalidationPromises.push(
      invalidateCache(`*:${visitId}:*`),
      invalidateCache(`*visitId=${visitId}*`),
      invalidateCache(`${CACHE_KEYS.VISIT}:${visitId}`)
    );
  }

  return Promise.all(cacheInvalidationPromises);
}

/**
 * Invalidates cache related to payments when payment data changes
 * @param {number} clinicId - The clinic ID
 * @param {number} visitId - The visit ID (optional)
 */
export function invalidatePaymentRelatedCaches({
  clinicId,
  branchId,
  visitId,
}: {
  clinicId: number;
  branchId?: number;
  visitId?: number;
}) {
  const cacheInvalidationPromises = [
    // Invalidate payment listings
    invalidateCache(`${CACHE_KEYS.PAYMENTS}:${clinicId}:${branchId}:*`),
    // Invalidate analytics
    invalidateCache(`${CACHE_KEYS.ANALYTICS.REVENUE}*`),
    // Invalidate dashboard stats
    invalidateDashboardRelatedCaches(clinicId),
  ];

  // If we have a visit ID, invalidate visit-specific caches
  if (visitId) {
    cacheInvalidationPromises.push(
      invalidateCache(`${CACHE_KEYS.VISITS}:*:*:*visitId=${visitId}*`)
    );
  }

  return Promise.all(cacheInvalidationPromises);
}

/**
 * Invalidates cache related to inventory when inventory data changes
 * @param {number} clinicId - The clinic ID (optional, can be undefined for SUPER_ADMIN)
 * @param {number} branchId - The branch ID (optional, can be undefined for SUPER_ADMIN)
 */
export function invalidateInventoryRelatedCaches({
  clinicId,
  branchId,
}: {
  clinicId?: number | null;
  branchId?: number | null;
}) {
  // Cache key formats used:
  // - inventory-items:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${params}
  // - inventory-batches:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${params}
  // - inventory:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:stock-transactions
  // We need to invalidate all possible combinations to ensure cache is cleared

  const patterns: string[] = [];

  // Normalize to match cache key format (null/undefined becomes "ALL")
  const clinicKey = clinicId ?? "ALL";
  const branchKey = branchId ?? "ALL";

  // Invalidate inventory-items cache (for the main inventory list)
  patterns.push(`inventory-items:${clinicKey}:${branchKey}:*`);
  if (clinicId) {
    patterns.push(`inventory-items:${clinicId}:ALL:*`);
  }
  if (branchId) {
    patterns.push(`inventory-items:ALL:${branchKey}:*`);
  }
  patterns.push("inventory-items:ALL:ALL:*");

  // Invalidate inventory-batches cache
  patterns.push(`inventory-batches:${clinicKey}:${branchKey}:*`);
  if (clinicId) {
    patterns.push(`inventory-batches:${clinicId}:ALL:*`);
  }
  if (branchId) {
    patterns.push(`inventory-batches:ALL:${branchKey}:*`);
  }
  patterns.push("inventory-batches:ALL:ALL:*");

  // Invalidate stock transactions cache
  patterns.push(`inventory:${clinicKey}:${branchKey}:stock-transactions`);
  if (clinicId) {
    patterns.push(`inventory:${clinicId}:ALL:stock-transactions`);
  }
  if (branchId) {
    patterns.push(`inventory:ALL:${branchKey}:stock-transactions`);
  }
  patterns.push("inventory:ALL:ALL:stock-transactions");

  // Also invalidate any other inventory-related caches
  patterns.push(`${CACHE_KEYS.INVENTORY}:*`);

  return Promise.all(patterns.map((pattern) => invalidateCache(pattern)));
}

/**
 * Invalidates cache related to dashboard
 * @param {number} clinicId - The clinic ID (optional)
 */
export function invalidateDashboardRelatedCaches(clinicId?: number) {
  const cacheInvalidationPromises = [invalidateDashboardCache()];

  if (clinicId) {
    cacheInvalidationPromises.push(
      invalidateCache(`*:${clinicId}:dashboard:*`)
    );
  }

  return Promise.all(cacheInvalidationPromises);
}

/**
 * Invalidates cache related to appointments
 * @param {number} doctorId - The doctor ID
 * @param {Date} date - The appointment date (optional)
 */
export function invalidateAppointmentRelatedCaches({
  doctorId,
  date,
}: {
  doctorId?: number;
  date?: Date;
}) {
  const cacheInvalidationPromises: Promise<void>[] = [];
  if (doctorId) {
    cacheInvalidationPromises.push(
      invalidateCache(
        `${CACHE_KEYS.APPOINTMENTS.DOCTOR_APPOINTMENTS}:${doctorId}:*`
      )
    );
  }

  if (date) {
    const formattedDate = format(date, "yyyy-MM-dd");
    cacheInvalidationPromises.push(
      invalidateCache(
        `${CACHE_KEYS.APPOINTMENTS.DOCTOR_AVAILABILITY}:${doctorId}:${formattedDate}`
      )
    );
  } else {
    cacheInvalidationPromises.push(
      invalidateCache(
        `${CACHE_KEYS.APPOINTMENTS.DOCTOR_AVAILABILITY}:${doctorId}:*`
      )
    );
  }

  return Promise.all(cacheInvalidationPromises);
}

/**
 * Invalidates cache related to insurance claims
 * @param {number} clinicId - The clinic ID
 * @param {number} branchId - The branch ID
 */
export function invalidateInsuranceClaimRelatedCaches({
  clinicId,
  branchId,
}: {
  clinicId?: number | null;
  branchId?: number | null;
}) {
  const patterns: string[] = [];

  const clinicKey = clinicId ?? "ALL";
  const branchKey = branchId ?? "ALL";

  // Invalidate all insurance claim caches for this clinic/branch combination
  // Pattern matches: insurance-claims:${clinicId}:${branchId}:*
  patterns.push(`insurance-claims:${clinicKey}:${branchKey}:*`);

  // Also invalidate broader patterns to ensure all variants are cleared
  if (clinicId) {
    patterns.push(`insurance-claims:${clinicId}:ALL:*`);
  }
  if (branchId) {
    patterns.push(`insurance-claims:ALL:${branchId}:*`);
  }
  // Invalidate the most general pattern as fallback
  patterns.push("insurance-claims:ALL:ALL:*");

  return Promise.all(patterns.map((pattern) => invalidateCache(pattern)));
}

export const invalidatePatientCache = async (patientId: number) => {
  // We need to get the patient's phone number first to invalidate the cache
  const patient = await db.patient.findUnique({
    where: { id: patientId },
    select: { phoneNumber: true },
  });

  if (patient) {
    await invalidateCache(
      `${CACHE_KEYS.PATIENTS}:phone:${patient.phoneNumber}`
    );
  }
};
