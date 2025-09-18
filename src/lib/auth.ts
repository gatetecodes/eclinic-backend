import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { type Branch, type Clinic, PrismaClient } from "../../generated/prisma";

const prisma = new PrismaClient();

const SESSION_EXPIRES_IN_DAYS = 7;
const SESSION_EXPIRES_IN = 60 * 60 * 24 * SESSION_EXPIRES_IN_DAYS; // 7 days
const SESSION_UPDATE_AGE = 60 * 60 * 24; // 1 day

const IS_NUMERIC_STRING = /^-?\d+$/;

// Wrap Prisma client to coerce string userId -> number for auth models
function createCoercingPrisma(client: PrismaClient): PrismaClient {
  const targetModels = new Set([
    "account",
    "session",
    "twofactorconfirmation",
    "user",
  ]);

  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  const isNumericString = (s: unknown): s is string =>
    typeof s === "string" && IS_NUMERIC_STRING.test(s);

  type CoerceResult =
    | { coerced: true; value: number | string | Date | null }
    | { coerced: false };

  const coerceUserField = (key: string, value: unknown): CoerceResult => {
    if (key === "emailVerified" && typeof value === "boolean") {
      return { coerced: true, value: value ? new Date() : null };
    }
    if (
      (key === "clinicId" || key === "branchId" || key === "id") &&
      isNumericString(value)
    ) {
      return { coerced: true, value: Number(value) };
    }
    return { coerced: false };
  };
  const coerceAccountRelatedField = (
    model: string,
    key: string,
    value: unknown
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
  ): CoerceResult => {
    if (model === "account") {
      if ((key === "userId" || key === "id") && isNumericString(value)) {
        return { coerced: true, value: Number(value) };
      }
      if (key === "accountId" && typeof value === "number") {
        return { coerced: true, value: String(value) };
      }
      return { coerced: false };
    }
    if (model === "session" || model === "twofactorconfirmation") {
      if ((key === "userId" || key === "id") && isNumericString(value)) {
        return { coerced: true, value: Number(value) };
      }
      return { coerced: false };
    }
    return { coerced: false };
  };

  const coerceValue = (
    model: string,
    key: string,
    value: unknown
  ): CoerceResult => {
    // Only coerce on allowlisted keys per model
    if (model === "user") {
      return coerceUserField(key, value);
    }
    return coerceAccountRelatedField(model, key, value);
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recursive coercion for Prisma args
  const coerceDeep = (v: unknown, model: string): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        coerceDeep(item, model);
      }
      return;
    }
    if (!isObject(v)) {
      return;
    }
    for (const key of Object.keys(v)) {
      const value = (v as Record<string, unknown>)[key];
      const result = coerceValue(model, key, value);
      if (result.coerced) {
        (v as Record<string, unknown>)[key] = result.value as unknown;
        continue;
      }
      // Handle nested where clauses like { where: { id: "1" } }
      if (key === "where" && isObject(value)) {
        coerceDeep(value, model);
        continue;
      }
      coerceDeep(value, model);
    }
  };

  const proxied = new Proxy(client as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") {
        return original;
      }
      const model = prop.toLowerCase();
      if (!targetModels.has(model)) {
        return original;
      }
      if (!isObject(original)) {
        return original;
      }
      return new Proxy(original as Record<string, unknown>, {
        get(modelTarget, methodProp, r2) {
          const method = Reflect.get(modelTarget, methodProp, r2);
          if (typeof method !== "function") {
            return method;
          }
          return (
            args: Record<string, unknown> | undefined,
            ...rest: unknown[]
          ) => {
            if (isObject(args)) {
              coerceDeep(args, model);
            }
            if (model === "account") {
              const _where = (args as Record<string, unknown> | undefined)
                ?.where;
            }
            return (method as (...a: unknown[]) => unknown).apply(modelTarget, [
              args,
              ...rest,
            ]);
          };
        },
      });
    },
  });

  return proxied as unknown as PrismaClient;
}

const prismaForAuth = createCoercingPrisma(prisma);

const backendUrl = process.env.BACKEND_URL;
const frontendUrl = process.env.APP_URL;

if (!(backendUrl && frontendUrl)) {
  throw new Error("BACKEND_URL or APP_URL is not set");
}

if (!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
  throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set");
}

export const auth = betterAuth({
  baseURL: backendUrl,
  trustedOrigins: [frontendUrl],
  database: prismaAdapter(prismaForAuth, {
    provider: "postgresql",
  }),
  // Mount under v1 router at /auth so the final path is /api/v1/auth/*
  basePath: "/auth",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  socialProviders: {
    // google: {
    //   clientId: process.env.GOOGLE_CLIENT_ID!,
    //   clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    // },
    // github: {
    //   clientId: process.env.GITHUB_CLIENT_ID!,
    //   clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    // },
  },
  session: {
    expiresIn: SESSION_EXPIRES_IN,
    updateAge: SESSION_UPDATE_AGE,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
      },
      clinicId: {
        type: "number",
        required: false,
      },
      branchId: {
        type: "number",
        required: false,
      },
      status: {
        type: "string",
        required: true,
        defaultValue: "ACTIVE",
      },
      phone_number: {
        type: "string",
        required: true,
      },
      consultationFee: {
        type: "number",
        required: false,
      },
      licenseExpiration: {
        type: "date",
        required: false,
      },
      licenseNumber: {
        type: "string",
        required: false,
      },
      license_document: {
        type: "string",
        required: false,
      },
      diploma_document: {
        type: "string",
        required: false,
      },
      highestEducation: {
        type: "string",
        required: false,
      },
      isTwoFactorEnabled: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
    },
  },
  advanced: {
    database: {
      generateId: false,
    },
  },
  plugins: [
    // Add any better-auth plugins here
  ],
});

export type Session = Omit<typeof auth.$Infer.Session, "user"> & {
  user: typeof auth.$Infer.Session.user & {
    role: string;
    clinic: Clinic;
    branch: Branch;
  };
};
export type User = Session["user"];
