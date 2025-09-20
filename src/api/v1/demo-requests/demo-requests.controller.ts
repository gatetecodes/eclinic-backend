import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  type DemoRequest,
  DemoRequestStatus,
  type Prisma,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { sendEmail } from "../../../services/email.service";
import type { demoRequestSchema } from "./demo-requests.validation";

export const createDemoRequest = async (c: Context) => {
  try {
    const data = c.get("validatedJson") as z.infer<typeof demoRequestSchema>;

    if (!data) {
      return c.json(
        { error: "Invalid data" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
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
    return c.json(
      { message: "Demo request created successfully", data: demoRequest },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
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
    return c.json(
      {
        message: "Demo requests fetched successfully",
        data: demoRequests,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const approveDemoRequest = async (c: Context) => {
  try {
    const { id } = c.req.param();

    const idNum = Number(id);

    if (!Number.isInteger(idNum) || idNum <= 0) {
      return c.json(
        { error: "Invalid ID" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const existing = await db.demoRequest.findUnique({ where: { id: idNum } });

    if (!existing) {
      return c.json(
        { error: "Demo request not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const demoRequest = await db.demoRequest.update({
      where: { id: idNum },
      data: { status: DemoRequestStatus.APPROVED },
    });

    try {
      await sendEmail({
        to: demoRequest.email,
        subject: "Demo Request Approved",
        template: "demo-request",
        context: {
          name: demoRequest.clinic_name,
          clinic_name: demoRequest.clinic_name,
          email: demoRequest.email,
          phone_number: demoRequest.phone_number,
          address: demoRequest.address,
          demo_date: demoRequest.demo_date,
        },
      });
    } catch (error) {
      logger.error("Approved without email notification", { id: idNum, error });
    }
    return c.json(
      { message: "Demo request approved successfully", data: demoRequest },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const rejectDemoRequest = async (c: Context) => {
  try {
    const { id } = c.req.param();

    const idNum = Number(id);

    if (!Number.isInteger(idNum) || idNum <= 0) {
      return c.json(
        { error: "Invalid ID" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const existing = await db.demoRequest.findUnique({ where: { id: idNum } });

    if (!existing) {
      return c.json(
        { error: "Demo request not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const demoRequest = await db.demoRequest.update({
      where: { id: idNum },
      data: { status: DemoRequestStatus.REJECTED },
    });
    return c.json(
      { message: "Demo request rejected successfully", data: demoRequest },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
