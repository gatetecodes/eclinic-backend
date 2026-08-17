import { logger } from "@/lib/logger";
import {
  type FhirPatient,
  fhirBundleSchema,
  fhirPatientSchema,
} from "./fhir.schemas";
import { type HieRequestEnvironment, rhieRequest } from "./rhie-client";

export type NationalPatientMatch = {
  externalPatientId: string;
  upid: string | null;
  nid: string | null;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  gender: string | null;
  phoneNumber: string | null;
  email: string | null;
  address: string | null;
  structuredAddress: RwandaAdministrativeAddress | null;
  deceased: boolean;
};

type AdministrativeLevel = {
  name: string;
  id: string | null;
};

export type RwandaAdministrativeAddress = {
  province: AdministrativeLevel | null;
  district: AdministrativeLevel | null;
  sector: AdministrativeLevel | null;
  cell: AdministrativeLevel | null;
  village: AdministrativeLevel | null;
};

type AddressLevel = keyof RwandaAdministrativeAddress;

const ADDRESS_LEVELS: AddressLevel[] = [
  "province",
  "district",
  "sector",
  "cell",
  "village",
];

export function parseRwandaAdministrativeAddress(
  address: FhirPatient["address"][number] | undefined
): RwandaAdministrativeAddress | null {
  if (!address) {
    return null;
  }
  const values = new Map<AddressLevel, { name?: string; id?: string }>();
  const source = address.line?.join(", ") ?? "";
  const labelledPart =
    /\b(Province|District|Sector|Cell|Village)(Id)?\s*:\s*([^,]+)/gi;
  for (const match of source.matchAll(labelledPart)) {
    const level = match[1]?.toLowerCase() as AddressLevel | undefined;
    const value = match[3]?.trim();
    if (!(level && value && ADDRESS_LEVELS.includes(level))) {
      continue;
    }
    const current = values.get(level) ?? {};
    if (match[2]) {
      current.id = value;
    } else {
      current.name = value;
    }
    values.set(level, current);
  }

  const fallbacks: Partial<Record<AddressLevel, string | undefined>> = {
    province: address.state,
    district: address.district,
    sector: address.city,
  };
  const structured = Object.fromEntries(
    ADDRESS_LEVELS.map((level) => {
      const parsed = values.get(level);
      const name = parsed?.name ?? fallbacks[level];
      return [
        level,
        name ? { name: name.trim(), id: parsed?.id ?? null } : null,
      ];
    })
  ) as RwandaAdministrativeAddress;

  return ADDRESS_LEVELS.some((level) => structured[level] !== null)
    ? structured
    : null;
}

export function formatRwandaAdministrativeAddress(
  address: RwandaAdministrativeAddress | null
) {
  if (!address) {
    return null;
  }
  const display = ADDRESS_LEVELS.flatMap((level) => {
    const value = address[level];
    return value ? [value.name] : [];
  }).join(", ");
  return display || null;
}

/** Contact systems the registry has been seen using for a telephone number. */
const PHONE_SYSTEMS = new Set(["phone", "sms", "mobile", "tel", "telephone"]);
const EMAIL_SYSTEMS = new Set(["email", "e-mail", "mail"]);
/** A value has to hold at least this many digits to be dialable. */
const MIN_PHONE_DIGITS = 6;
const NON_DIGIT_PATTERN = /\D/g;

type ContactPoint = FhirPatient["telecom"][number];

/** Every contact point on the patient, then on any related party. */
function contactPoints(patient: FhirPatient): ContactPoint[] {
  return [
    ...patient.telecom,
    ...patient.contact.flatMap((related) => related.telecom),
  ];
}

/**
 * Picks the first contact point of a kind that actually carries a value.
 *
 * The registry regularly sends a well-formed entry with no `value` at all
 * (`{ system: "phone", use: "mobile" }`). Selecting on `system` alone and then
 * reading `.value` lets such an entry mask a populated one later in the same
 * list, which reads downstream as "the citizen has no phone number".
 */
function contactValue(
  patient: FhirPatient,
  systems: ReadonlySet<string>
): string | null {
  for (const point of contactPoints(patient)) {
    const system = point.system?.trim().toLowerCase();
    const value = point.value?.trim();
    if (system && systems.has(system) && value) {
      return value;
    }
  }
  return null;
}

/**
 * Last resort for a number whose entry omits `system`: a value that is mostly
 * digits is a phone number, an address never is.
 */
function untypedPhone(patient: FhirPatient): string | null {
  for (const point of contactPoints(patient)) {
    const value = point.value?.trim();
    if (point.system?.trim() || !value || value.includes("@")) {
      continue;
    }
    if (value.replace(NON_DIGIT_PATTERN, "").length >= MIN_PHONE_DIGITS) {
      return value;
    }
  }
  return null;
}

function phoneNumber(patient: FhirPatient): string | null {
  return contactValue(patient, PHONE_SYSTEMS) ?? untypedPhone(patient);
}

function identifier(patient: FhirPatient, type: string): string | null {
  return (
    patient.identifier.find(
      (item) => item.system?.toUpperCase() === type.toUpperCase()
    )?.value ?? null
  );
}

function toNationalPatient(patient: FhirPatient): NationalPatientMatch {
  const name = patient.name[0];
  const structuredAddress = parseRwandaAdministrativeAddress(
    patient.address[0]
  );
  return {
    externalPatientId: patient.id,
    upid: identifier(patient, "UPI") ?? identifier(patient, "UPID"),
    nid: identifier(patient, "NID"),
    firstName: name?.given?.join(" ") ?? "",
    lastName: name?.family ?? "",
    birthDate: patient.birthDate ?? null,
    gender: patient.gender ?? null,
    phoneNumber: phoneNumber(patient),
    email: contactValue(patient, EMAIL_SYSTEMS),
    address: formatRwandaAdministrativeAddress(structuredAddress),
    structuredAddress,
    deceased: patient.deceasedBoolean === true,
  };
}

/**
 * Fills a missing phone number by reading the patient resource directly.
 *
 * The Client Registry's search response is not always the full record: the
 * `Patient` entries in a search Bundle can arrive with no `telecom` at all, or
 * with a contact point that carries `system`/`use` but no `value`, for a citizen
 * whose number the registry does hold. `GET Patient/{id}` returns the complete
 * resource, so one extra read recovers the number instead of sending reception a
 * blank field.
 *
 * Only performed when the search result actually lacks a phone number, and never
 * allowed to fail the lookup — a citizen found without a phone number is a far
 * better outcome than a citizen not found at all.
 */
async function completeContactDetails(
  match: NationalPatientMatch,
  tenantEnvironment: HieRequestEnvironment,
  request: typeof rhieRequest,
  context: { correlationId: string }
): Promise<NationalPatientMatch> {
  if (match.phoneNumber) {
    return match;
  }
  try {
    const response = await request({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: `Patient/${match.externalPatientId}`,
      tenantEnvironment,
    });
    const parsed = fhirPatientSchema.safeParse(response.data);
    if (!parsed.success) {
      return match;
    }
    const full = toNationalPatient(parsed.data);
    return {
      ...match,
      phoneNumber: full.phoneNumber,
      email: match.email ?? full.email,
      address: match.address ?? full.address,
      structuredAddress: match.structuredAddress ?? full.structuredAddress,
    };
  } catch (error) {
    logger.warn("hie.registry.patient_read_failed", {
      correlationId: context.correlationId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return match;
  }
}

export async function lookupNationalPatient(
  params: {
    nid: string;
    birthDate: string;
    tenantEnvironment: HieRequestEnvironment;
  },
  request: typeof rhieRequest = rhieRequest
): Promise<{
  matches: NationalPatientMatch[];
  correlationId: string;
}> {
  const response = await request({
    service: "CLIENT_REGISTRY",
    method: "GET",
    path: "Patient",
    tenantEnvironment: params.tenantEnvironment,
    query: { identifier: params.nid, birthdate: params.birthDate },
  });
  const bundle = fhirBundleSchema.parse(response.data);
  const searchMatches = bundle.entry.flatMap((entry) => {
    const parsed = fhirPatientSchema.safeParse(entry.resource);
    if (!parsed.success) {
      logger.warn("hie.registry.patient_unparsable", {
        correlationId: response.correlationId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      });
      return [];
    }
    const patient = toNationalPatient(parsed.data);
    if (patient.birthDate !== params.birthDate || patient.nid !== params.nid) {
      return [];
    }
    return [patient];
  });
  const matches = await Promise.all(
    searchMatches.map((match) =>
      completeContactDetails(match, params.tenantEnvironment, request, {
        correlationId: response.correlationId,
      })
    )
  );
  return { matches, correlationId: response.correlationId };
}
