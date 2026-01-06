import { z } from "zod";
import { QueueEntryStatus } from "../../../../generated/prisma/client";

export const createQueueConfigSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  departmentId: z.number().optional(),
  doctorId: z.number().optional(),
  autoOpenTime: z.string().optional(),
  autoCloseTime: z.string().optional(),
  isAutoOpenEnabled: z.boolean().optional(),
  defaultAvgTime: z.number().optional(),
  maxCapacity: z.number().optional(),
  slug: z.string().optional(),
  isPublic: z.boolean().optional(),
});

export const updateQueueConfigSchema = createQueueConfigSchema.partial();

export const nextPatientSchema = z.object({
  status: z.enum(QueueEntryStatus),
});
