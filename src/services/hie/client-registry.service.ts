import {
  type FhirPatient,
  fhirBundleSchema,
  fhirPatientSchema,
} from "./fhir.schemas";
import { rhieRequest } from "./rhie-client";

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
    phoneNumber:
      patient.telecom.find((item) => item.system === "phone")?.value ?? null,
    email:
      patient.telecom.find((item) => item.system === "email")?.value ?? null,
    address: formatRwandaAdministrativeAddress(structuredAddress),
    structuredAddress,
    deceased: patient.deceasedBoolean === true,
  };
}

export async function lookupNationalPatient(params: {
  nid: string;
  birthDate: string;
}): Promise<{ matches: NationalPatientMatch[]; correlationId: string }> {
  const response = await rhieRequest({
    service: "CLIENT_REGISTRY",
    method: "GET",
    path: "Patient",
    query: { identifier: params.nid, birthdate: params.birthDate },
  });
  const bundle = fhirBundleSchema.parse(response.data);
  const matches = bundle.entry.flatMap((entry) => {
    const parsed = fhirPatientSchema.safeParse(entry.resource);
    if (!parsed.success) {
      return [];
    }
    const patient = toNationalPatient(parsed.data);
    if (patient.birthDate !== params.birthDate || patient.nid !== params.nid) {
      return [];
    }
    return [patient];
  });
  return { matches, correlationId: response.correlationId };
}
