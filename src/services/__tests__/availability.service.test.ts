import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/database/db", () => {
  return {
    db: {
      staffTimesheet: {
        findMany: vi.fn(),
      },
    },
  };
});

let getUserAvailability: typeof import("../availability.service").getUserAvailability;
let db: typeof import("@/database/db").db;

describe("getUserAvailability", () => {
  beforeAll(async () => {
    ({ getUserAvailability } = await import("../availability.service"));
    ({ db } = await import("@/database/db"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when no timesheets", async () => {
    db.staffTimesheet.findMany.mockResolvedValueOnce([]);
    const res = await getUserAvailability({
      userId: 1,
      date: new Date("2025-01-10T00:00:00Z"),
    });
    expect(res.availableTimes).toEqual([]);
  });

  it("handles cross-midnight weekly shift (prev day to current day)", async () => {
    const date = new Date("2025-01-07T12:00:00Z"); // Tuesday (2)
    const prevDay = 1; // Monday
    const targetDay = 2; // Tuesday
    db.staffTimesheet.findMany.mockResolvedValueOnce([
      {
        id: 10,
        userId: 1,
        clinicId: 1,
        periodType: "WEEK",
        startDate: null,
        endDate: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        shifts: [
          {
            id: 100,
            timesheetId: 10,
            daysOfWeek: [prevDay, targetDay],
            startTime: "22:00",
            endTime: "02:00",
            branchId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        exceptions: [],
      },
    ]);
    const res = await getUserAvailability({ userId: 1, date, slotMinutes: 60 });
    // Expect slots within the target day: 00:00 and 01:00
    expect(res.availableTimes).toContain("00:00");
    expect(res.availableTimes).toContain("01:00");
    // Should not include 22:00 of previous day in current day
    expect(res.availableTimes).not.toContain("22:00");
  });

  it("filters by branchId", async () => {
    const date = new Date("2025-01-07T12:00:00Z"); // Tuesday
    db.staffTimesheet.findMany.mockResolvedValueOnce([
      {
        id: 10,
        userId: 1,
        clinicId: 1,
        periodType: "WEEK",
        startDate: null,
        endDate: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        shifts: [
          {
            id: 100,
            timesheetId: 10,
            daysOfWeek: [date.getDay()],
            startTime: "09:00",
            endTime: "10:00",
            branchId: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        exceptions: [],
      },
    ]);
    const res = await getUserAvailability({
      userId: 1,
      date,
      branchId: 6,
      slotMinutes: 60,
    });
    expect(res.availableTimes).toEqual([]);
  });
});
