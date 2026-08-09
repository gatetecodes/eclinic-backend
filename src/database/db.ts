import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../../generated/prisma/client";
import { careStageForStatus } from "../lib/care-stage";

/**
 * Keeps `Visit.careStage` in sync with `Visit.status` for every write, so no
 * transition site has to remember to set it. Whenever a `status` is written
 * without an explicit `careStage`, we derive the stage from the status. Callers
 * that need a precise stage (e.g. PHARMACY vs BILLING) can still pass
 * `careStage` explicitly — it always takes precedence.
 */
const syncCareStageInData = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return data;
  }
  const d = data as Record<string, unknown>;
  // Prisma update can pass `{ status: { set: X } }`; handle both shapes.
  const rawStatus =
    d.status && typeof d.status === "object" && "set" in (d.status as object)
      ? (d.status as { set?: unknown }).set
      : d.status;
  if (typeof rawStatus === "string" && d.careStage === undefined) {
    d.careStage = careStageForStatus(rawStatus as never);
  }
  return d;
};

const prismaClientSingleton = () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL environment variable");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: ["error", "warn"],
    transactionOptions: {
      maxWait: 10_000,
      timeout: 10_000,
    },
  }).$extends({
    query: {
      visit: {
        create({ args, query }) {
          syncCareStageInData(args.data);
          return query(args);
        },
        update({ args, query }) {
          syncCareStageInData(args.data);
          return query(args);
        },
        updateMany({ args, query }) {
          syncCareStageInData(args.data);
          return query(args);
        },
        upsert({ args, query }) {
          syncCareStageInData(args.create);
          syncCareStageInData(args.update);
          return query(args);
        },
      },
    },
  });
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const extendedDb = globalThis.prisma ?? prismaClientSingleton();

// The extension only changes Visit write behavior; it adds no public client
// methods. Export the stable PrismaClient surface to prevent recursive types.
const db = extendedDb as unknown as PrismaClient;

if (process.env.NODE_ENV === "development") {
  globalThis.prisma = extendedDb;
}

export { db };
