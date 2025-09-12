import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const backendUrl = process.env.BACKEND_URL;
const frontendUrl = process.env.APP_URL;

if (!backendUrl || !frontendUrl) {
  throw new Error("BACKEND_URL or APP_URL is not set");
}

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set");
}

export const auth = betterAuth({
  baseURL: backendUrl,
  trustedOrigins: [frontendUrl],
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  basePath: "/api/v1/auth",
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
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
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
