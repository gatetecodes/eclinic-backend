import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "../../generated/prisma";

const prisma = new PrismaClient();

const SESSION_EXPIRES_IN_DAYS = 7;
const SESSION_EXPIRES_IN = 60 * 60 * 24 * SESSION_EXPIRES_IN_DAYS; // 7 days
const SESSION_UPDATE_AGE = 60 * 60 * 24; // 1 day

const IS_NUMERIC_STRING = /^-?\d+$/;

// Wrap Prisma client to coerce string userId -> number for auth models
function createCoercingPrisma(client: PrismaClient): PrismaClient {
  const targetModels = new Set(["account", "session", "twofactorconfirmation"]);

  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  const isNumericString = (s: unknown): s is string =>
    typeof s === "string" && IS_NUMERIC_STRING.test(s);

  const coerceDeep = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        coerceDeep(item);
      }
      return;
    }
    if (!isObject(v)) {
      return;
    }
    // Convert digit-only strings to numbers for auth models
    for (const key of Object.keys(v)) {
      const value = (v as Record<string, unknown>)[key];
      if (isNumericString(value)) {
        (v as Record<string, unknown>)[key] = Number(
          value
        ) as unknown as number;
      } else {
        coerceDeep(value);
      }
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
              coerceDeep(args);
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
    requireEmailVerification: true,
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
        required: true,
        defaultValue: false,
      },
    },
  },
  plugins: [
    // Add any better-auth plugins here
  ],
});

export type Session = Omit<typeof auth.$Infer.Session, "user"> & {
  user: typeof auth.$Infer.Session.user & { role: string };
};
export type User = Session["user"];
