import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import jwt from "jsonwebtoken";
import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { QueueConfigService } from "@/services/queue-config.service";
import { QueueFlowService } from "@/services/queue-flow.service";
import { QueueManagerService } from "@/services/queue-manager.service";
import {
  QueueEntryStatus,
  QueueSource,
} from "../../../../generated/prisma/client";

const TRAILING_SLASH_REGEX = /\/$/;

function getFrontendBaseUrl(origin: string | undefined): string | null {
  const eclinicUrl = process.env.APP_URL;
  const queuelessUrl = process.env.NEXT_UP_URL;

  if (!origin) {
    return eclinicUrl || queuelessUrl || null;
  }

  try {
    if (queuelessUrl && origin.includes(new URL(queuelessUrl).host)) {
      return queuelessUrl;
    }
    if (eclinicUrl && origin.includes(new URL(eclinicUrl).host)) {
      return eclinicUrl;
    }
  } catch {
    // ignore
  }

  return eclinicUrl || queuelessUrl || null;
}

export const QueuesController = {
  // --- Configuration (Protected) ---

  createConfig: async (c: Context) => {
    const user = c.get("user");
    const clinicId = user.clinicId; // Provided by tenant middleware
    const branchId = user.branchId;

    const {
      name,
      description,
      slug,
      isPublic,
      departmentId,
      doctorId,
      autoOpenTime,
      autoCloseTime,
      isAutoOpenEnabled,
      defaultAvgTime,
      maxCapacity,
    } = c.get("validatedJson");

    if (!clinicId) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Clinic ID missing",
        code: "CONTEXT_ERROR",
      });
    }

    if (!branchId) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Branch ID missing",
        code: "CONTEXT_ERROR",
      });
    }

    const config = await QueueConfigService.create({
      name,
      description,
      slug,
      isPublic,
      departmentId,
      doctorId,
      autoOpenTime,
      autoCloseTime,
      isAutoOpenEnabled,
      clinicId,
      branchId,
      defaultAvgTime,
      maxCapacity,
    });
    return c.json(
      { success: "Service configuration created", data: config },
      httpCodes.CREATED as ContentfulStatusCode
    );
  },

  listConfigs: async (c: Context) => {
    const user = c.get("user");
    const clinicId = user.clinicId;
    const configs = await QueueConfigService.listByClinic(clinicId);
    return c.json({ success: true, data: configs });
  },

  updateConfig: async (c: Context) => {
    const { id } = c.get("validatedParam");
    const user = c.get("user");
    const clinicId = user.clinicId;

    if (!clinicId) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Clinic ID missing",
        code: "CONTEXT_ERROR",
      });
    }

    const body = await c.req.json();

    //Verify ownership before update
    const existingConfig = await QueueConfigService.getById(id);

    if (!existingConfig) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Config not found",
        code: "NOT_FOUND",
      });
    }

    if (existingConfig.clinicId !== clinicId) {
      throw new AppError({
        status: httpCodes.FORBIDDEN,
        message: "Access denied",
        code: "FORBIDDEN",
      });
    }

    const config = await QueueConfigService.update(id, body);
    return c.json({ success: "Service configuration updated", data: config });
  },

  deleteConfig: async (c: Context) => {
    const { id } = c.get("validatedParam");
    const user = c.get("user");
    const clinicId = user.clinicId;

    if (!clinicId) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Clinic ID missing",
        code: "CONTEXT_ERROR",
      });
    }

    const existingConfig = await QueueConfigService.getById(id);

    if (!existingConfig) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Config not found",
        code: "NOT_FOUND",
      });
    }

    if (existingConfig.clinicId !== clinicId) {
      throw new AppError({
        status: httpCodes.FORBIDDEN,
        message: "Access denied",
        code: "FORBIDDEN",
      });
    }

    await db.queueConfig.delete({ where: { id } });
    return c.json({ success: "Service configuration deleted" });
  },

  getQueueConfigQr: async (c: Context) => {
    const { id } = c.get("validatedParam") as { id: number };
    const user = c.get("user");
    const clinicId = user.clinicId;

    if (!clinicId) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Clinic ID missing",
        code: "CONTEXT_ERROR",
      });
    }

    const secret = process.env.NEXTUP_QR_SECRET;
    const publicUrl = getFrontendBaseUrl(c.req.header("origin"));

    if (!(secret && publicUrl)) {
      throw new AppError({
        status: httpCodes.INTERNAL_SERVER_ERROR,
        message: "QR code configuration missing",
        code: "QR_CONFIG_MISSING",
      });
    }

    const config = await QueueConfigService.getById(id);
    if (!config) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Config not found",
        code: "NOT_FOUND",
      });
    }

    if (config.clinicId !== clinicId) {
      throw new AppError({
        status: httpCodes.FORBIDDEN,
        message: "Access denied",
        code: "FORBIDDEN",
      });
    }

    const ttlSeconds = Number(
      process.env.QUEUELESS_QR_TTL_SECONDS ?? "2592000"
    ); // 30d
    const expiresIn =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 2_592_000;

    const token = jwt.sign(
      { queueConfigId: config.id, clinicId: config.clinicId },
      secret,
      { expiresIn }
    );

    const normalizedPublicUrl = publicUrl.replace(TRAILING_SLASH_REGEX, "");
    const joinUrl = `${normalizedPublicUrl}/q/${token}`;

    logger.info("qr.issued", {
      clinicId: config.clinicId,
      queueConfigId: config.id,
      userId: user.id,
      expiresInSeconds: expiresIn,
    });

    return c.json({ success: true, data: { token, joinUrl } });
  },

  // --- Operations (Protected) ---

  openQueue: async (c: Context) => {
    const configId = Number(c.req.param("id"));
    const queue = await QueueManagerService.openQueue(configId);
    return c.json({ success: "Queue opened", data: queue });
  },

  closeQueue: async (c: Context) => {
    const queueId = Number(c.req.param("id"));
    const queue = await QueueManagerService.closeQueue(queueId);
    return c.json({ success: "Queue closed", data: queue });
  },

  listActiveQueues: async (c: Context) => {
    const user = c.get("user");
    const clinicId = user.clinicId;
    const queues = await QueueManagerService.listActiveQueues(clinicId);
    return c.json({ success: true, data: queues });
  },

  nextPatient: async (c: Context) => {
    // Logic: Find current serving, mark done. Find next waiting, mark notified/serving.
    // For simplicity, we expose updateStatus.
    const entryId = Number(c.req.param("entryId"));
    const body = await c.req.json().catch(() => ({}));
    const status = (c.req.query("status") || body.status) as QueueEntryStatus;

    if (!Object.values(QueueEntryStatus).includes(status)) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Invalid status",
        code: "INVALID_STATUS",
      });
    }

    const entry = await QueueFlowService.updateStatus(entryId, status);
    return c.json({ success: "Status updated", data: entry });
  },

  // --- Public (No Auth) ---

  getPublicClinic: async (c: Context) => {
    const slug = c.req.param("slug");

    // The slug exists on QueueConfig, so this returns a specific queue's config.
    // If the frontend needs a full clinic landing page, we would need to fetch all public queues
    // for a clinic. For now, since `slug` is unique to a QueueConfig, this acts as the
    // "Queue Landing Page" endpoint.

    const config = await QueueConfigService.getBySlug(slug);
    if (!config) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Queue not found",
        code: "NOT_FOUND",
      });
    }
    return c.json({ success: true, data: config });
  },

  joinQueuePublic: async (c: Context) => {
    const queueId = Number(c.req.param("id"));
    const body = await c.req.json();
    const {
      phoneNumber,
      name,
      patientLat,
      patientLng,
      travelTimeEstimate,
      source,
    } = body;

    if (!phoneNumber) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Phone number required",
        code: "MISSING_PHONE",
      });
    }

    const entry = await QueueFlowService.joinQueue({
      queueId,
      phoneNumber,
      name,
      patientLat,
      patientLng,
      travelTimeEstimate,
      source: Object.values(QueueSource).includes(source)
        ? (source as QueueSource)
        : QueueSource.KIOSK,
    });

    logger.info("qr.joined", {
      queueId,
      entryId: entry.id,
      source: entry.source,
    });

    return c.json({ success: true, data: entry });
  },

  getEntryStatus: async (c: Context) => {
    const id = c.req.param("id");
    const entry = await QueueFlowService.getEntryStatus(id);
    if (!entry) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Entry not found",
        code: "NOT_FOUND",
      });
    }
    return c.json({ success: true, data: entry });
  },
};
