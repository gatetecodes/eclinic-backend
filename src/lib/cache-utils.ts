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
  branchId: number;
  visitId?: number;
  patientId?: number;
  doctorId?: number;
}) {
  const cacheInvalidationPromises = [
    // Invalidate all visit listings regardless of role and params
    invalidateCache(`${CACHE_KEYS.VISITS}:${clinicId}:${branchId}:*`),
    invalidateCache(`${CACHE_KEYS.VISIT}:${visitId}`),
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
      invalidateCache(`*visitId=${visitId}*`)
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
  branchId: number;
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
 * @param {number} clinicId - The clinic ID
 */
export function invalidateInventoryRelatedCaches({
  clinicId,
  branchId,
}: {
  clinicId: number;
  branchId: number;
}) {
  return invalidateCache(`${CACHE_KEYS.INVENTORY}:${clinicId}:${branchId}:*`);
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
  doctorId: number;
  date?: Date;
}) {
  const cacheInvalidationPromises = [
    invalidateCache(
      `${CACHE_KEYS.APPOINTMENTS.DOCTOR_APPOINTMENTS}:${doctorId}:*`
    ),
  ];

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
