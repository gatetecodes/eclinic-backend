import dotenv from "dotenv";

dotenv.config({ path: ".env" });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema",
  migrations: {
    path: "./prisma/migrations",
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
});
