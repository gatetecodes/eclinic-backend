import { afterEach, beforeAll, describe, expect, it } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

let mapRegistryLocation: typeof import("../facility-registry.service").mapRegistryLocation;

const originalFosaSystem = process.env.HIE_FACILITY_REGISTRY_FOSA_SYSTEM;

beforeAll(async () => {
  ({ mapRegistryLocation } = await import("../facility-registry.service"));
});

afterEach(() => {
  if (originalFosaSystem === undefined) {
    process.env.HIE_FACILITY_REGISTRY_FOSA_SYSTEM = undefined;
  } else {
    process.env.HIE_FACILITY_REGISTRY_FOSA_SYSTEM = originalFosaSystem;
  }
});

const location = (overrides: Record<string, unknown> = {}) => ({
  resourceType: "Location",
  id: "1163f2b9-08b0-4333-8e60-6a6fadc91f4f",
  status: "active",
  name: "Kibagabaga Level Two Teaching Hospital",
  identifier: [{ system: "http://moh.gov.rw/fosa", value: "0022" }],
  type: [{ text: "District Hospital" }],
  address: { state: "Kigali", district: "Gasabo" },
  ...overrides,
});

describe("mapRegistryLocation", () => {
  it("maps a Location to a directory row with a usable reference", () => {
    const mapped = mapRegistryLocation(location());
    expect(mapped).toEqual({
      fosaCode: "0022",
      resourceType: "Location",
      resourceId: "1163f2b9-08b0-4333-8e60-6a6fadc91f4f",
      locationReference: "Location/1163f2b9-08b0-4333-8e60-6a6fadc91f4f",
      organizationReference: null,
      name: "Kibagabaga Level Two Teaching Hospital",
      facilityType: "District Hospital",
      province: "Kigali",
      district: "Gasabo",
      identifierSystem: "http://moh.gov.rw/fosa",
    });
  });

  it("prefers the pinned identifier system over the name heuristic", () => {
    process.env.HIE_FACILITY_REGISTRY_FOSA_SYSTEM = "urn:rw:fosa";
    const mapped = mapRegistryLocation(
      location({
        identifier: [
          { system: "http://moh.gov.rw/fosa", value: "9999" },
          { system: "urn:rw:fosa", value: "0022" },
        ],
      })
    );
    expect(mapped?.fosaCode).toBe("0022");
    expect(mapped?.identifierSystem).toBe("urn:rw:fosa");
  });

  it("falls back to a FOSA-shaped value when no system is recognisable", () => {
    const mapped = mapRegistryLocation(
      location({
        identifier: [
          { system: "http://example.org/internal", value: "not-a-code" },
          { system: "http://example.org/other", value: "0424" },
        ],
      })
    );
    expect(mapped?.fosaCode).toBe("0424");
  });

  it("maps an Organization to a FOSA-derived Location reference", () => {
    // The registry publishes only Organizations, but our mappings and the
    // Encounter payloads built from them reference `Location/<fosaCode>` — MoH's
    // own convention. Keeping the Organization reference too preserves the trail
    // back to the source record.
    const mapped = mapRegistryLocation({
      resourceType: "Organization",
      id: "org-1",
      name: "Kicukiro Health Center",
      identifier: [{ system: "fosa", value: "0001" }],
      address: [{ state: "Kigali", district: "Kicukiro" }],
    });
    expect(mapped?.resourceType).toBe("Organization");
    expect(mapped?.locationReference).toBe("Location/0001");
    expect(mapped?.organizationReference).toBe("Organization/org-1");
    // Read from the list form when an address is present, though the live
    // registry publishes none.
    expect(mapped?.district).toBe("Kicukiro");
  });

  it("skips a resource with no derivable FOSA code rather than guessing", () => {
    expect(
      mapRegistryLocation(
        location({ identifier: [{ system: "urn:other", value: "ABC" }] })
      )
    ).toBeNull();
    expect(mapRegistryLocation(location({ identifier: [] }))).toBeNull();
  });

  it("skips a resource with no name or no id", () => {
    expect(mapRegistryLocation(location({ name: undefined }))).toBeNull();
    expect(mapRegistryLocation(location({ name: "   " }))).toBeNull();
    expect(mapRegistryLocation(location({ id: undefined }))).toBeNull();
  });

  it("skips an unrelated resource type", () => {
    expect(
      mapRegistryLocation({ resourceType: "Patient", id: "p1", name: "x" })
    ).toBeNull();
  });

  it("tolerates the partial and valueless fields the RHIE actually sends", () => {
    // A registry payload carrying a valueless telecom, an empty coding array and
    // a missing address must still yield a usable facility. A strict sub-field
    // here would drop the whole entry — the same failure already seen on
    // Client Registry citizen search.
    const mapped = mapRegistryLocation(
      location({
        address: undefined,
        type: [{ coding: [] }],
        telecom: [{ system: "phone" }],
        extension: [{ url: "unexpected" }],
      })
    );
    expect(mapped?.fosaCode).toBe("0022");
    expect(mapped?.facilityType).toBeNull();
    expect(mapped?.province).toBeNull();
    expect(mapped?.district).toBeNull();
  });

  it("reads a display when the type carries no text", () => {
    const mapped = mapRegistryLocation(
      location({ type: [{ coding: [{ display: "Health Post" }] }] })
    );
    expect(mapped?.facilityType).toBe("Health Post");
  });
});

describe("live registry payload", () => {
  // Verbatim from the MoH test gateway: every one of its 3,212 entries is an
  // Organization with no address and the category in an extension. Locking the
  // real shape in means a change on their side fails here rather than silently
  // emptying the picker.
  const liveOrganization = {
    resourceType: "Organization",
    id: "org-2684",
    extension: [{ url: "urn:frpr:org-category", valueString: "Health Post" }],
    identifier: [{ system: "urn:frpr:facility-code", value: "2684" }],
    name: "Mutanda HP",
  };

  it("maps the live Organization shape to a mappable facility", () => {
    const mapped = mapRegistryLocation(liveOrganization);
    expect(mapped).toEqual({
      fosaCode: "2684",
      resourceType: "Organization",
      resourceId: "org-2684",
      // Derived from the FOSA code, matching MoH's own Encounter convention
      // (`Location/0424` alongside `identifier.value: "0424"`).
      locationReference: "Location/2684",
      organizationReference: "Organization/org-2684",
      name: "Mutanda HP",
      facilityType: "Health Post",
      province: null,
      district: null,
      identifierSystem: "urn:frpr:facility-code",
    });
  });

  it("reads the category from the extension, not from type", () => {
    const mapped = mapRegistryLocation(liveOrganization);
    expect(mapped?.facilityType).toBe("Health Post");
  });

  it("still prefers a real Location's own id when one is published", () => {
    const mapped = mapRegistryLocation({
      resourceType: "Location",
      id: "1163f2b9-08b0-4333-8e60-6a6fadc91f4f",
      name: "Kibagabaga",
      identifier: [{ system: "urn:frpr:facility-code", value: "0022" }],
    });
    expect(mapped?.locationReference).toBe(
      "Location/1163f2b9-08b0-4333-8e60-6a6fadc91f4f"
    );
  });

  it("ignores an unrelated extension", () => {
    const mapped = mapRegistryLocation({
      ...liveOrganization,
      extension: [{ url: "urn:frpr:something-else", valueString: "nope" }],
    });
    expect(mapped?.facilityType).toBeNull();
  });
});
