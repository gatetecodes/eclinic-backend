import { PrismaClient } from "../../generated/prisma";

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: ["error", "warn"],
    transactionOptions: {
      maxWait: 10000,
      timeout: 10000,
    },
  });
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const db = globalThis.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV === "development") globalThis.prisma = db;

export { db };
