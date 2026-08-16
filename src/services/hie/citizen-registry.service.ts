import { type CitizenDocumentType, citizenDataSchema } from "./citizen.schemas";
import { type HieRequestEnvironment, rhieRequest } from "./rhie-client";

/**
 * Minimized citizen view returned to the caller.
 *
 * Only the fields a receptionist needs to confirm they have the right person
 * are surfaced. The raw registry payload — which also carries parents' names,
 * full domicile breakdown, civil status and a photo — is never returned, never
 * logged, and never persisted.
 */
export type CitizenUpidMatch = {
  upid: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  gender: string | null;
  /** Present only when the registry echoes a NID back. */
  nid: string | null;
};

/** Maps the registry's free-text sex value onto FHIR administrative gender. */
function normalizeGender(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "M" || normalized === "MALE") {
    return "male";
  }
  if (normalized === "F" || normalized === "FEMALE") {
    return "female";
  }
  return "unknown";
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** Keeps only an unambiguous ISO date; the registry's other formats are dropped. */
function normalizeBirthDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(ISO_DATE_PATTERN);
  return match ? match[0] : null;
}

/**
 * Resolves a national UPID for a patient the Client Registry has no FHIR
 * `Patient` for yet.
 *
 * Returns `null` when the registry responds successfully but has no UPID for
 * the document — a legitimate "not found", not an error. Transport failures
 * still throw, so the caller can distinguish "no such citizen" from "the
 * registry is down".
 */
export async function requestCitizenUpid(
  params: {
    documentType: CitizenDocumentType;
    documentNumber: string;
    fosaid: string;
    tenantEnvironment: HieRequestEnvironment;
  },
  request: typeof rhieRequest = rhieRequest
): Promise<{ match: CitizenUpidMatch | null; correlationId: string }> {
  const response = await request({
    service: "CITIZEN",
    method: "POST",
    path: "getCitizen",
    tenantEnvironment: params.tenantEnvironment,
    body: {
      documentType: params.documentType,
      documentNumber: params.documentNumber,
      fosaid: params.fosaid,
    },
  });
  const parsed = citizenDataSchema.safeParse(response.data);
  const citizen = parsed.success ? parsed.data.data : null;
  const upid = citizen?.upi?.trim();
  if (!upid) {
    return { match: null, correlationId: response.correlationId };
  }
  return {
    match: {
      upid,
      firstName: citizen?.postNames?.trim() ?? "",
      lastName: citizen?.surName?.trim() ?? "",
      birthDate: normalizeBirthDate(citizen?.dateOfBirth),
      gender: normalizeGender(citizen?.sex),
      nid: citizen?.nid?.trim() ?? null,
    },
    correlationId: response.correlationId,
  };
}
