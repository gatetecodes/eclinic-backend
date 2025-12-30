import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "@/database/db";
import { hashCredentialPassword } from "@/helpers/auth-helper";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import {
  BranchStatus,
  Role,
  SubscriptionPlan,
  SubscriptionStatus,
  UserStatus,
} from "../../../../generated/prisma/client";

export const OnboardingController = {
  registerQueueLess: async (c: Context) => {
    const body = await c.req.json();
    const { clinicName, adminName, email, password, phone } = body;

    if (!(clinicName && adminName && email && password && phone)) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Missing required fields",
        code: "INVALID_INPUT",
      });
    }

    // Check email
    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError({
        status: httpCodes.CONFLICT,
        message: "Email already registered",
        code: "EMAIL_EXISTS",
      });
    }

    // Use project's standard password hashing helper
    const hashedPassword = hashCredentialPassword(password);

    // Transaction
    const result = await db.$transaction(async (tx) => {
      // 1. Create Clinic
      const clinic = await tx.clinic.create({
        data: {
          name: clinicName,
          subscriptionStatus: SubscriptionStatus.TRIAL,
          subscriptionPlan: SubscriptionPlan.CLINIC_STARTER, // Or QUEUE_ONLY if added
          contactEmail: email,
          contactPhone: phone,
        },
      });

      // 2. Create Head Office Branch
      const branch = await tx.branch.create({
        data: {
          name: "Main Branch",
          code: "MAIN",
          isHeadOffice: true,
          status: BranchStatus.ACTIVE,
          clinicId: clinic.id,
          contactEmail: email,
          contactPhone: phone,
        },
      });

      // 3. Create Admin User
      const user = await tx.user.create({
        data: {
          name: adminName,
          email,
          role: Role.CLINIC_ADMIN,
          status: UserStatus.ACTIVE,
          phone_number: phone,
          clinicId: clinic.id,
          branchId: branch.id,
          emailVerified: new Date(), // Auto-verify for simplicity in this flow? Or keep null.
        },
      });

      // 4. Create Authentication Account (Better-Auth)
      await tx.account.create({
        data: {
          providerId: "credential",
          accountId: user.id.toString(), // Usually mapped to user ID for credential provider
          userId: user.id,
          password: hashedPassword,
        },
      });

      // 5. Create Default Queue
      await tx.queueConfig.create({
        data: {
          clinicId: clinic.id,
          branchId: branch.id,
          name: "General Queue",
          isPublic: true,
          isAutoOpenEnabled: true,
          defaultAvgTime: 15,
          autoOpenTime: "08:00",
          autoCloseTime: "17:00",
        },
      });

      return { clinic, user };
    });

    return c.json(
      {
        success: true,
        data: {
          clinicId: result.clinic.id,
          userId: result.user.id,
          message: "Registration successful",
        },
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  },
};
