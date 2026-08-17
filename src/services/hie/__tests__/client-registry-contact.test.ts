import { describe, expect, it } from "bun:test";
import { lookupNationalPatient } from "../client-registry.service";

const NID = "1198780012345678";
const BIRTH_DATE = "1987-01-01";

type ContactPoint = { system?: string; value?: string; use?: string };

const patientResource = (overrides: Record<string, unknown> = {}) => ({
  resourceType: "Patient",
  id: "abc-123",
  identifier: [
    { system: "NID", value: NID },
    { system: "UPI", value: "UPI-123" },
  ],
  name: [{ family: "MUGEMA", given: ["JEAN", "NEPO"] }],
  gender: "male",
  birthDate: BIRTH_DATE,
  address: [{ line: ["Province: South"], state: "South", country: "Rwanda" }],
  ...overrides,
});

/**
 * Stands in for the exchange: the search path answers with a Bundle, the
 * resource path with a single Patient. Omitting `read` makes the direct read
 * fail, which is how a registry that only supports search behaves.
 */
const registry =
  (search: unknown, read?: unknown) =>
  // biome-ignore lint/suspicious/useAwait: matches the async request signature
  async (params: { path: string }) => {
    if (params.path === "Patient") {
      return {
        data: {
          resourceType: "Bundle",
          type: "searchset",
          total: 1,
          entry: [{ fullUrl: "Patient/abc-123", resource: search }],
        },
        correlationId: "search-correlation",
      };
    }
    if (!read) {
      throw new Error("registry read unavailable");
    }
    return { data: read, correlationId: "read-correlation" };
  };

const lookup = async (search: unknown, read?: unknown) => {
  const result = await lookupNationalPatient(
    { nid: NID, birthDate: BIRTH_DATE, tenantEnvironment: "SANDBOX" },
    registry(search, read) as never
  );
  return result.matches[0];
};

const withTelecom = (...telecom: ContactPoint[]) =>
  patientResource({ telecom });

describe("national patient contact details", () => {
  it("reads a phone number from the documented telecom shape", async () => {
    const match = await lookup(
      withTelecom({ system: "phone", value: "078812345", use: "mobile" })
    );
    expect(match?.phoneNumber).toBe("078812345");
  });

  it("does not let a valueless contact point mask a populated one", async () => {
    const match = await lookup(
      withTelecom(
        { system: "phone", use: "mobile" },
        { system: "phone", value: "078812345" }
      )
    );
    expect(match?.phoneNumber).toBe("078812345");
  });

  it("accepts contact systems outside the FHIR phone/email pair", async () => {
    const sms = await lookup(
      withTelecom({ system: "SMS", value: "078812345" })
    );
    expect(sms?.phoneNumber).toBe("078812345");
    // An unrecognised system must never cost us the whole patient.
    const unknown = await lookup(
      withTelecom(
        { system: "pager-over-carrier-pigeon", value: "x" },
        { system: "phone", value: "078812345" }
      )
    );
    expect(unknown?.phoneNumber).toBe("078812345");
  });

  it("falls back to a digit-shaped value when the system is missing", async () => {
    const match = await lookup(withTelecom({ value: "0788123456" }));
    expect(match?.phoneNumber).toBe("0788123456");
  });

  it("never mistakes an email address for a phone number", async () => {
    const match = await lookup(withTelecom({ value: "aline@example.rw" }));
    expect(match?.phoneNumber).toBeNull();
  });

  it("reads a number carried on a related contact party", async () => {
    const match = await lookup(
      patientResource({
        contact: [{ telecom: [{ system: "phone", value: "078899999" }] }],
      })
    );
    expect(match?.phoneNumber).toBe("078899999");
  });

  it("keeps the patient when address.line arrives as a bare string", async () => {
    const match = await lookup({
      ...withTelecom({ system: "phone", value: "078812345" }),
      address: [{ line: "Province: South", state: "South" }],
    });
    expect(match?.phoneNumber).toBe("078812345");
    expect(match?.structuredAddress?.province?.name).toBe("South");
  });

  it("recovers a phone number the search result omitted by reading the patient", async () => {
    const match = await lookup(
      patientResource(),
      withTelecom({ system: "phone", value: "078877777" })
    );
    expect(match?.phoneNumber).toBe("078877777");
  });

  it("still returns the match when the follow-up read fails", async () => {
    const match = await lookup(patientResource());
    expect(match?.externalPatientId).toBe("abc-123");
    expect(match?.phoneNumber).toBeNull();
  });

  it("does not spend a second call when the search already has a number", async () => {
    const paths: string[] = [];
    const request = registry(
      withTelecom({ system: "phone", value: "078812345" })
    );
    await lookupNationalPatient(
      { nid: NID, birthDate: BIRTH_DATE, tenantEnvironment: "SANDBOX" },
      (async (params: { path: string }) => {
        paths.push(params.path);
        return await request(params);
      }) as never
    );
    expect(paths).toEqual(["Patient"]);
  });
});
