import { z } from "zod";
import { fhirResourceSchema } from "./fhir.schemas";

/**
 * Schemas for the national Facility and Provider registries.
 *
 * These live apart from `fhir.schemas.ts` on purpose. Those schemas guard what
 * we *publish* and are deliberately strict — a malformed Observation must not
 * reach the SHR. These schemas guard what we *read* from a registry list, where
 * strictness is actively harmful: the facility bundle arrives 200 entries at a
 * time, and the RHIE has already been observed shipping valueless identifiers on
 * citizen search. A required sub-field here would discard 199 usable facilities
 * because of one malformed neighbour.
 *
 * So: everything below the resource type is optional and passthrough, and
 * `facility-registry.service.ts` decides which entries are usable.
 */

const registryCodingSchema = z
  .object({
    system: z.string().optional(),
    code: z.string().optional(),
    display: z.string().optional(),
  })
  .passthrough();

const registryCodeableConceptSchema = z
  .object({
    coding: z.array(registryCodingSchema).optional(),
    text: z.string().optional(),
  })
  .passthrough();

const registryIdentifierSchema = z
  .object({
    system: z.string().optional(),
    value: z.string().optional(),
    use: z.string().optional(),
    type: registryCodeableConceptSchema.optional(),
  })
  .passthrough();

const registryAddressSchema = z
  .object({
    city: z.string().optional(),
    district: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

/**
 * A facility as the Facility Registry publishes it. `name` and `identifier` are
 * optional at the schema level even though an entry without either is useless —
 * `mapRegistryLocation` rejects those individually so the rest of the page
 * survives.
 */
export const registryLocationSchema = fhirResourceSchema("Location").extend({
  status: z.string().optional(),
  name: z.string().optional(),
  alias: z.array(z.string()).optional(),
  identifier: z.array(registryIdentifierSchema).optional(),
  type: z.array(registryCodeableConceptSchema).optional(),
  physicalType: registryCodeableConceptSchema.optional(),
  address: registryAddressSchema.optional(),
});

export type RegistryLocation = z.infer<typeof registryLocationSchema>;

/**
 * A facility as the live registry publishes it.
 *
 * Confirmed against the MoH test gateway: every one of the 3,212 entries is an
 * `Organization`, never a `Location`, shaped as
 * `{ id: "org-2684", identifier: [{ system: "urn:frpr:facility-code", value:
 * "2684" }], name: "Mutanda HP", extension: [{ url: "urn:frpr:org-category",
 * valueString: "Health Post" }] }`. No address is published, so province and
 * district stay null.
 */
export const registryOrganizationSchema = fhirResourceSchema(
  "Organization"
).extend({
  active: z.boolean().optional(),
  name: z.string().optional(),
  alias: z.array(z.string()).optional(),
  identifier: z.array(registryIdentifierSchema).optional(),
  type: z.array(registryCodeableConceptSchema).optional(),
  address: z.array(registryAddressSchema).optional(),
  /**
   * The live registry carries the facility category here rather than in `type`,
   * as `{ url: "urn:frpr:org-category", valueString: "Health Post" }`.
   */
  extension: z
    .array(
      z
        .object({
          url: z.string().optional(),
          valueString: z.string().optional(),
        })
        .passthrough()
    )
    .optional(),
});

/** Extension URL carrying the facility category in the live registry. */
export const FRPR_ORG_CATEGORY_URL = "urn:frpr:org-category";

export type RegistryOrganization = z.infer<typeof registryOrganizationSchema>;

/**
 * A practitioner as the Provider Registry publishes it.
 */
export const registryPractitionerSchema = fhirResourceSchema(
  "Practitioner"
).extend({
  active: z.boolean().optional(),
  identifier: z.array(registryIdentifierSchema).optional(),
  name: z
    .array(
      z
        .object({
          text: z.string().optional(),
          family: z.string().optional(),
          given: z.array(z.string()).optional(),
          prefix: z.array(z.string()).optional(),
        })
        .passthrough()
    )
    .optional(),
});

export type RegistryPractitioner = z.infer<typeof registryPractitionerSchema>;

/**
 * Response of `Practitioner/{license}/status`.
 *
 * The MoH collection ships no example response for this endpoint — the shape
 * here is inferred from the sibling `hwms/license-status` request body
 * (`{licenseNumber, licenseStatus, reason}`). Passthrough plus all-optional
 * keeps an unexpected shape from throwing; `provider-registry.service.ts`
 * treats an absent `licenseStatus` as unknown rather than as valid.
 */
export const practitionerLicenseStatusSchema = z
  .object({
    licenseNumber: z.string().optional(),
    licenseStatus: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type PractitionerLicenseStatus = z.infer<
  typeof practitionerLicenseStatusSchema
>;
