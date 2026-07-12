import "dotenv/config";
import { db } from "../../src/database/db";

/**
 * One-time backfill for the timesheet supersession model.
 *
 * The old renewal flow created a new StaffTimesheet on every renewal but only
 * deactivated *overlapping* prior sheets. A renewal's window starts after the
 * old one ends, so it never overlapped — leaving expired sheets isActive:true
 * and piling up in the listing forever.
 *
 * The new invariant is "exactly one active timesheet per staff member per
 * period type." This script enforces it retroactively: within each
 * (userId, periodType) group of active sheets it keeps the most current one
 * (latest startDate, then latest createdAt, then highest id) and flips the
 * rest to isActive:false. Nothing is deleted — superseded rows remain in the
 * DB and are reachable via the includeHistory view for audit.
 *
 * Idempotent: a second run finds one active sheet per group and does nothing.
 *
 * Run with:  bun run prisma/scripts/backfill-superseded-timesheets.ts
 */
async function main() {
  console.log("Collapsing superseded staff timesheets...");

  const active = await db.staffTimesheet.findMany({
    where: { isActive: true },
    select: {
      id: true,
      userId: true,
      periodType: true,
      startDate: true,
      createdAt: true,
    },
  });

  console.log(`Scanning ${active.length} active timesheets.`);

  const groups = new Map<string, typeof active>();
  for (const ts of active) {
    const key = `${ts.userId}::${ts.periodType}`;
    const arr = groups.get(key) ?? [];
    arr.push(ts);
    groups.set(key, arr);
  }

  const idsToDeactivate: number[] = [];
  for (const sheets of groups.values()) {
    if (sheets.length <= 1) {
      continue;
    }
    // Keep the most current sheet; supersede everything older in the group.
    sheets.sort((a, b) => {
      const byStart = b.startDate.getTime() - a.startDate.getTime();
      if (byStart !== 0) {
        return byStart;
      }
      const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
      if (byCreated !== 0) {
        return byCreated;
      }
      return b.id - a.id;
    });
    const [, ...superseded] = sheets;
    idsToDeactivate.push(...superseded.map((s) => s.id));
  }

  console.log(
    `Found ${groups.size} staff/period groups; ${idsToDeactivate.length} superseded sheets to deactivate.`
  );

  if (idsToDeactivate.length === 0) {
    console.log("Nothing to backfill — data already satisfies the invariant.");
    return;
  }

  const result = await db.staffTimesheet.updateMany({
    where: { id: { in: idsToDeactivate } },
    data: { isActive: false },
  });

  console.log(
    `Backfill complete. Deactivated ${result.count} superseded timesheets.`
  );
}

main()
  .catch((e) => {
    console.error("Error during backfill:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
