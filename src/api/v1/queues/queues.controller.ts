import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { QueueConfigService } from "@/services/queue-config.service";
import { QueueFlowService } from "@/services/queue-flow.service";
import { QueueManagerService } from "@/services/queue-manager.service";
import {
  QueueEntryStatus,
  QueueSource,
} from "../../../../generated/prisma/client";

export const QueuesController = {
  // --- Configuration (Protected) ---

  createConfig: async (c: Context) => {
    const user = c.get("user");
    const clinicId = user.clinicId; // Provided by tenant middleware
    const branchId = user.branchId;
    const body = await c.req.json();

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
      ...body,
      clinicId,
      branchId,
    });
    return c.json(
      { success: true, data: config },
      httpCodes.CREATED as ContentfulStatusCode
    );
  },

  listConfigs: async (c: Context) => {
    const user = c.get("user");
    const clinicId = user.clinicId;
    const configs = await QueueConfigService.listByClinic(clinicId);
    return c.json({ success: true, data: configs });
  },

  // --- Operations (Protected) ---

  openQueue: async (c: Context) => {
    const configId = Number(c.req.param("id"));
    const queue = await QueueManagerService.openQueue(configId);
    return c.json({ success: true, data: queue });
  },

  closeQueue: async (c: Context) => {
    const queueId = Number(c.req.param("id"));
    const queue = await QueueManagerService.closeQueue(queueId);
    return c.json({ success: true, data: queue });
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
    const status = c.req.query("status") as QueueEntryStatus;

    if (!Object.values(QueueEntryStatus).includes(status)) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Invalid status",
        code: "INVALID_STATUS",
      });
    }

    const entry = await QueueFlowService.updateStatus(entryId, status);
    return c.json({ success: true, data: entry });
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
    const { phoneNumber, name, patientLat, patientLng, travelTimeEstimate } =
      body;

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
      source: QueueSource.WHATSAPP, // or determine from UA
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
