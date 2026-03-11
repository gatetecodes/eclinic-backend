import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { generateSlug } from "@/lib/utils";
import type { QueueConfig, QueuePurpose } from "../../generated/prisma/client";

const resolveUniqueSlug = async (
  name: string,
  providedSlug?: string | null,
  excludeId?: number
): Promise<string> => {
  const trimmedProvided = providedSlug?.trim();

  const slug =
    trimmedProvided && trimmedProvided.length > 0
      ? trimmedProvided
      : generateSlug(name);

  const isCustom = !!(trimmedProvided && trimmedProvided.length > 0);

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

  // Retry logic for auto-generated slugs
  let attempt = 0;

  const maxAttempts = 10;

  while (attempt < maxAttempts) {
    const randomStr = Math.random().toString(36).substring(2, 6);

    const candidateSlug = `${slug}-${randomStr}`;

    const conflict = await db.queueConfig.findFirst({
      where: {
        slug: candidateSlug,
        id: excludeId ? { not: excludeId } : undefined,
      },
    });
    if (!conflict) {
      return candidateSlug;
    }
    attempt++;
  }

  throw new AppError({
    status: httpCodes.INTERNAL_SERVER_ERROR,
    message: "Failed to generate unique slug",
    code: "SLUG_GENERATION_FAILED",
  });
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
    purpose?: QueuePurpose;
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

  listByClinic: async (clinicId: number, doctorId?: number) => {
    return await db.queueConfig.findMany({
      where: {
        clinicId,
        doctorId: doctorId !== undefined ? doctorId : undefined,
      },
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
