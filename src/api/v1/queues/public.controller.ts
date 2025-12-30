import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { QueueEntryStatus } from "../../../../generated/prisma/client";

export const PublicController = {
  /**
   * Search for clinics with public queues
   * @param c - The context object
   * @returns - The clinics with public queues and pagination metadata
   * @throws {AppError} - If the query is not valid
   */
  searchClinics: async (c: Context) => {
    const query = c.req.query("q");
    const page = Number(c.req.query("page")) || 1;
    const limit = Number(c.req.query("limit")) || 10;

    // Validate pagination params
    if (page < 1) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Page must be >= 1",
        code: "INVALID_PAGE",
      });
    }

    if (limit < 1 || limit > 100) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Limit must be between 1 and 100",
        code: "INVALID_LIMIT",
      });
    }

    // biome-ignore lint/suspicious/noExplicitAny: Prisma where clause is dynamic
    const whereClause: any = {
      // Only show clinics that have at least one public queue
      queueConfigs: {
        some: { isPublic: true },
      },
    };

    if (query && query.length > 0) {
      whereClause.name = { contains: query, mode: "insensitive" };
    }

    // Get total count for pagination
    const total = await db.clinic.count({ where: whereClause });

    // Calculate pagination
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    const clinics = await db.clinic.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        logo: true,
        branches: {
          where: { isHeadOffice: true },
          select: { address: true },
        },
      },
      skip,
      take: limit,
      orderBy: { name: "asc" }, // Consistent ordering
    });

    return c.json(
      {
        success: true,
        data: clinics,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  },

  /**
   * List public queues (services) for a clinic
   * @param c - The context object
   * @returns - The public queues for the clinic
   * @throws {AppError} - If the clinic ID is not valid
   */
  getClinicQueues: async (c: Context) => {
    const clinicId = Number(c.req.param("clinicId"));

    if (Number.isNaN(clinicId)) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Invalid clinic ID",
        code: "INVALID_CLINIC_ID",
      });
    }

    const queues = await db.queueConfig.findMany({
      where: {
        clinicId,
        isPublic: true,
      },
      include: {
        // Include active queue status to show current wait time
        doctor: {
          select: { name: true },
        },
        queues: {
          where: {
            status: "OPEN",
            closeAt: null,
          },
          include: {
            entries: {
              where: { status: QueueEntryStatus.WAITING },
            },
          },
          take: 1, // Only the current session
          orderBy: { createdAt: "desc" },
        },
      },
    });

    // Transform to simple format for Bot/App
    const data = queues.map((config) => {
      const activeSession = config.queues[0];
      const waitingCount = activeSession?.entries.length || 0;
      const estimatedWaitMinutes = waitingCount * config.defaultAvgTime;

      return {
        id: config.id, // QueueConfig ID (Service ID)
        name: config.name,
        doctorName: config.doctor?.name || null,
        isOpen: !!activeSession,
        waitingCount,
        estimatedWaitMinutes,
        activeQueueId: activeSession?.id, // Needed to join
      };
    });

    return c.json({ success: true, data });
  },

  /**
   * Check if a patient exists
   * @param c - The context object
   * @returns - The patient if found
   * @throws {AppError} - If the phone number is not provided
   */
  checkPatient: async (c: Context) => {
    const { phoneNumber } = await c.req.json();

    if (!phoneNumber) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: "Phone number required",
        code: "MISSING_PHONE",
      });
    }

    const patient = await db.patient.findFirst({
      where: { phoneNumber },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    });

    return c.json({
      success: true,
      exists: !!patient,
      data: patient
        ? {
            name: `${patient.firstName} ${patient.lastName}`,
          }
        : null,
    });
  },
};
