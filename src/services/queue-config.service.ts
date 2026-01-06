import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { generateSlug } from "@/lib/utils";
import type { QueueConfig } from "../../generated/prisma/client";

const resolveUniqueSlug = async (
  name: string,
  providedSlug?: string | null,
  excludeId?: number
): Promise<string> => {
  const slug = providedSlug?.trim() || generateSlug(name);
  const isCustom = !!providedSlug?.trim();

  const existing = await db.queueConfig.findFirst({
    where: {
      slug,
      id: excludeId ? { not: excludeId } : undefined,
    },
  });

  if (!existing) {
    return slug;
  }

  if (isCustom) {
    throw new AppError({
      status: httpCodes.CONFLICT,
      message: "Slug already exists",
      code: "SLUG_EXISTS",
    });
  }

  const randomStr = Math.random().toString(36).substring(2, 6);
  return `${slug}-${randomStr}`;
};

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
    const slug = await resolveUniqueSlug(data.name, data.slug);
    const description = data.description?.trim() || null;
    const autoOpenTime = data.autoOpenTime?.trim() || null;
    const autoCloseTime = data.autoCloseTime?.trim() || null;

    return await db.queueConfig.create({
      data: {
        ...data,
        slug,
        description,
        autoOpenTime,
        autoCloseTime,
      },
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

    let slug: string | undefined;
    if (data.slug !== undefined) {
      slug = await resolveUniqueSlug(data.name || config.name, data.slug, id);
    }

    const description =
      data.description !== undefined
        ? data.description?.trim() || null
        : undefined;
    const autoOpenTime =
      data.autoOpenTime !== undefined
        ? data.autoOpenTime?.trim() || null
        : undefined;
    const autoCloseTime =
      data.autoCloseTime !== undefined
        ? data.autoCloseTime?.trim() || null
        : undefined;

    return await db.queueConfig.update({
      where: { id },
      data: {
        ...data,
        slug,
        description,
        autoOpenTime,
        autoCloseTime,
      },
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
