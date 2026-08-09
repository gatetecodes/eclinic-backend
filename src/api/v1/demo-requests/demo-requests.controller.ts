import type { Context } from "hono";
import type { z } from "zod";
import {
  type DemoRequest,
  DemoRequestStatus,
  type Prisma,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  jsonError,
  jsonSuccess,
  translateForContext,
} from "../../../lib/api-response";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { translate } from "../../../lib/i18n";
import { logger } from "../../../lib/logger";
import { writeAudit } from "../../../services/audit.service";
import { provisionClinic } from "../../../services/clinic-provisioning.service";
import { sendEmail } from "../../../services/email.service";
import { createVerificationEmail } from "../users/users.controller";
import type { demoRequestSchema } from "./demo-requests.validation";

export const createDemoRequest = async (c: Context) => {
  try {
    const data = c.get("validatedJson") as z.infer<typeof demoRequestSchema>;

    if (!data) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidData",
      });
    }

    const { clinic_name, email, phone_number, address, demo_date } = data;
    const demoRequest = await db.demoRequest.create({
      data: {
        clinic_name,
        email,
        phone_number,
        address,
        demo_date,
      },
    });
    return jsonSuccess(c, {
      status: httpCodes.CREATED,
      messageKey: "demo.requestCreated",
      data: demoRequest,
    });
  } catch (error) {
    logger.error("Failed to create demo request", { error });
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: translateForContext(c, "common.internalServerError"),
    });
  }
};

export const getDemoRequests = async (c: Context) => {
  try {
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<DemoRequest>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const demoRequests = await db.demoRequest.findMany({
      where: where as Prisma.DemoRequestWhereInput,
      orderBy: orderBy as Prisma.DemoRequestOrderByWithRelationInput,
      ...restOptions,
    });
    const totalCount = await db.demoRequest.count({
      where: where as Prisma.DemoRequestWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "demo.requestsFetched",
      data: demoRequests,
      meta: {
        totalCount,
        pageCount,
      },
    });
  } catch (error) {
    logger.error("Failed to fetch demo requests", { error });
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: translateForContext(c, "common.internalServerError"),
    });
  }
};

export const approveDemoRequest = async (c: Context) => {
  try {
    const { id } = c.req.param();

    const idNum = Number(id);

    if (!Number.isInteger(idNum) || idNum <= 0) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }

    const existing = await db.demoRequest.findUnique({ where: { id: idNum } });

    if (!existing) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        messageKey: "common.notFound",
      });
    }

    if (existing.status === DemoRequestStatus.APPROVED) {
      return jsonError(c, {
        status: httpCodes.CONFLICT,
        code: "CONFLICT",
        message: "Demo request is already approved",
      });
    }

    // Optional: provision a TRIAL clinic from the demo and link it back. Body
    // is optional, so tolerate a missing/invalid JSON payload.
    const body = (await c.req.json().catch(() => ({}))) as {
      provision?: boolean;
    };
    const shouldProvision = body.provision === true && !existing.clinicId;

    let provisionedClinicId: number | null = existing.clinicId ?? null;
    if (shouldProvision) {
      const existingUser = await db.user.findUnique({
        where: { email: existing.email },
        select: { id: true },
      });
      if (existingUser) {
        return jsonError(c, {
          status: httpCodes.CONFLICT,
          code: "CONFLICT",
          message: "A user with this email already exists",
        });
      }

      const { newClinic, adminUser } = await provisionClinic({
        name: existing.clinic_name,
        subscriptionPlan: "CLINIC_STARTER",
        subscriptionStatus: "TRIAL",
        contactEmail: existing.email,
        contactPhone: existing.phone_number,
        admin: {
          name: `${existing.clinic_name} Admin`,
          email: existing.email,
          phone_number: existing.phone_number,
        },
      });
      provisionedClinicId = newClinic.id;

      const verification = await createVerificationEmail(adminUser.email, {
        locale: c.get("locale"),
      });
      if (!verification.success) {
        logger.warn("Provisioned clinic but verification email failed", {
          clinicId: newClinic.id,
          email: adminUser.email,
          error: verification.error,
        });
      }

      await writeAudit(c, "demo.provisioned", {
        targetType: "clinic",
        targetId: newClinic.id,
        metadata: { demoRequestId: idNum },
      });
    }

    const demoRequest = await db.demoRequest.update({
      where: { id: idNum },
      data: {
        status: DemoRequestStatus.APPROVED,
        ...(provisionedClinicId ? { clinicId: provisionedClinicId } : {}),
      },
    });

    await writeAudit(c, "demo.approved", {
      targetType: "demoRequest",
      targetId: idNum,
    });

    try {
      const locale = c.get("locale");
      await sendEmail({
        to: demoRequest.email,
        subject: translate(locale, "demo.requestApprovedSubject"),
        template: "demo-request",
        context: {
          previewTitle: translate(locale, "email.demo.previewTitle"),
          title: translate(locale, "email.demo.title"),
          greeting: translate(locale, "email.demo.greeting"),
          body: translate(locale, "email.demo.body", {
            clinicName: demoRequest.clinic_name,
          }),
          nextText: translate(locale, "email.demo.next"),
          thanksText: translate(locale, "email.demo.thanks"),
          questionsText: translate(locale, "email.demo.questions"),
          phoneLabel: translate(locale, "email.demo.phone"),
          emailLabel: translate(locale, "email.demo.email"),
          signatureText: translate(locale, "email.demo.signature"),
          teamText: translate(locale, "email.demo.team"),
        },
      });
    } catch (error) {
      logger.error("Approved without email notification", { id: idNum, error });
    }
    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "demo.requestApproved",
    });
  } catch (error) {
    logger.error("Failed to approve demo request", { error });
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: translateForContext(c, "common.internalServerError"),
    });
  }
};

export const rejectDemoRequest = async (c: Context) => {
  try {
    const { id } = c.req.param();

    const idNum = Number(id);

    if (!Number.isInteger(idNum) || idNum <= 0) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }

    const existing = await db.demoRequest.findUnique({ where: { id: idNum } });

    if (!existing) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        messageKey: "common.notFound",
      });
    }

    await db.demoRequest.update({
      where: { id: idNum },
      data: { status: DemoRequestStatus.REJECTED },
    });
    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "demo.requestRejected",
    });
  } catch (error) {
    logger.error("Failed to reject demo request", { error });
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: translateForContext(c, "common.internalServerError"),
    });
  }
};
