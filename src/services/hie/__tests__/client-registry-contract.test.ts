import { describe, expect, it } from "bun:test";
import { lookupNationalPatient } from "../client-registry.service";

const nid = "1199880011223344";
const birthDate = "1988-01-02";

const request = (data: unknown) => async () => ({
  data,
  status: 200,
  correlationId: "contract-correlation",
});

describe("Client Registry contract handling", () => {
  it("accepts an exact NID and birth-date match", async () => {
    const result = await lookupNationalPatient(
      { nid, birthDate },
      request({
        resourceType: "Bundle",
        type: "searchset",
        entry: [
          {
            resource: {
              resourceType: "Patient",
              id: "patient-1",
              identifier: [
                { system: "NID", value: nid },
                { system: "UPID", value: "upid-1" },
              ],
              name: [{ family: "Kagabo", given: ["Eugene"] }],
              birthDate,
              gender: "male",
            },
          },
        ],
      })
    );

    expect(result).toMatchObject({
      correlationId: "contract-correlation",
      matches: [
        {
          externalPatientId: "patient-1",
          nid,
          upid: "upid-1",
          birthDate,
        },
      ],
    });
  });

  it("returns no match for an empty search result", async () => {
    await expect(
      lookupNationalPatient(
        { nid, birthDate },
        request({ resourceType: "Bundle", type: "searchset" })
      )
    ).resolves.toMatchObject({ matches: [] });
  });

  it("filters identifier or birth-date mismatches", async () => {
    const patient = {
      resourceType: "Patient",
      id: "patient-1",
      identifier: [{ system: "NID", value: nid }],
      name: [{ family: "Kagabo", given: ["Eugene"] }],
      birthDate: "1988-01-03",
    };
    await expect(
      lookupNationalPatient(
        { nid, birthDate },
        request({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{ resource: patient }],
        })
      )
    ).resolves.toMatchObject({ matches: [] });
  });

  it("rejects a malformed successful response", async () => {
    await expect(
      lookupNationalPatient(
        { nid, birthDate },
        request({ resourceType: "Patient" })
      )
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
