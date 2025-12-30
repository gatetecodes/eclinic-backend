import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import type { QueueConfig } from "../../generated/prisma/client";

export const QueueConfigService = {
  create: async (data: {
    clinicId: number;
    branchId: number;
    name: string;
    description?: string;
    slug?: string;
    isPublic?: boolean;
    departmentId?: number;
    doctorId?: number;
    autoOpenTime?: string;
    autoCloseTime?: string;
    isAutoOpenEnabled?: boolean;
    defaultAvgTime?: number;
    maxCapacity?: number;
  }) => {
    if (data.slug) {
      const existing = await db.queueConfig.findFirst({
        where: { slug: data.slug },
      });
      if (existing) {
        throw new AppError({
          status: httpCodes.CONFLICT,
          message: "Slug already exists",
          code: "SLUG_EXISTS",
        });
      }
    }

    return await db.queueConfig.create({
      data,
    });
  },

  update: async (
    id: number,
    data: Partial<
      Omit<QueueConfig, "id" | "clinicId" | "createdAt" | "updatedAt">
    >
  ) => {
    const config = await db.queueConfig.findUnique({ where: { id } });
    if (!config) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Queue configuration not found",
        code: "NOT_FOUND",
      });
    }

    if (data.slug) {
      const existing = await db.queueConfig.findFirst({
        where: { slug: data.slug, id: { not: id } },
      });
      if (existing) {
        throw new AppError({
          status: httpCodes.CONFLICT,
          message: "Slug already exists",
          code: "SLUG_EXISTS",
        });
      }
    }

    return await db.queueConfig.update({
      where: { id },
      data,
    });
  },

  getById: async (id: number) => {
    return await db.queueConfig.findUnique({
      where: { id },
      include: {
        department: true,
        doctor: true,
        branch: true,
      },
    });
  },

  listByClinic: async (clinicId: number) => {
    return await db.queueConfig.findMany({
      where: { clinicId },
      include: {
        department: true,
        doctor: true,
        branch: true,
      },
      orderBy: { createdAt: "desc" },
    });
  },

  getBySlug: async (slug: string) => {
    return await db.queueConfig.findUnique({
      where: { slug },
      include: {
        clinic: true,
        branch: true,
        department: true,
        doctor: true,
      },
    });
  },
};
