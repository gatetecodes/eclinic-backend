import { db } from "@/database/db";
import { DefaultDepartments } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { QueuePurpose, Role, UserStatus } from "../../generated/prisma/client";
import { QueueConfigService } from "./queue-config.service";

async function ensureConfig(
  configs: Array<{ id: number; name: string }>,
  exists: boolean,
  create: () => Promise<{ id: number; name: string }>,
  logContext: Record<string, unknown>
): Promise<void> {
  if (exists) {
    return;
  }
  try {
    const config = await create();
    configs.push(config);
  } catch (err) {
    logger.warn("Queue setup: Failed to create config", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Creates default queue configs for a branch when queue management is first enabled.
 * Each expected config is checked/created idempotently so branches with legacy configs
 * still get missing defaults, and concurrent calls do not create duplicates.
 */
export const QueueSetupService = {
  createDefaultConfigs: async (
    clinicId: number,
    branchId: number
  ): Promise<{
    created: number;
    configs: Array<{ id: number; name: string }>;
  }> => {
    const configs: Array<{ id: number; name: string }> = [];

    const [branch, doctors, labDept] = await Promise.all([
      db.branch.findUnique({
        where: { id: branchId, clinicId },
      }),
      db.user.findMany({
        where: {
          branchId,
          clinicId,
          role: Role.DOCTOR,
          status: UserStatus.ACTIVE,
        },
        select: { id: true, name: true },
      }),
      db.clinicalDepartment.findFirst({
        where: {
          name: DefaultDepartments.LABORATOIRE,
          clinics: { some: { id: clinicId } },
        },
        select: { id: true },
      }),
    ]);

    if (!branch) {
      throw new Error("Branch not found");
    }

    const [preExists, labExists] = await Promise.all([
      db.queueConfig.findFirst({
        where: {
          clinicId,
          branchId,
          departmentId: null,
          purpose: QueuePurpose.PRE_CONSULTATION,
        },
      }),
      db.queueConfig.findFirst({
        where: { clinicId, branchId, purpose: QueuePurpose.LAB },
      }),
    ]);

    await ensureConfig(
      configs,
      !!preExists,
      () =>
        QueueConfigService.create({
          clinicId,
          branchId,
          name: "Pre-consultation",
          description: "Pre-consultation queue for all departments",
          departmentId: undefined,
          purpose: QueuePurpose.PRE_CONSULTATION,
        }),
      { type: "pre-consultation" }
    );

    await ensureConfig(
      configs,
      !!labExists,
      () =>
        QueueConfigService.create({
          clinicId,
          branchId,
          name: "Lab",
          description: "Lab sample collection queue",
          departmentId: labDept?.id,
          purpose: QueuePurpose.LAB,
        }),
      { type: "lab" }
    );

    for (const doctor of doctors) {
      const doctorExists = await db.queueConfig.findFirst({
        where: {
          clinicId,
          branchId,
          doctorId: doctor.id,
          purpose: QueuePurpose.DOCTOR,
        },
      });
      await ensureConfig(
        configs,
        !!doctorExists,
        () =>
          QueueConfigService.create({
            clinicId,
            branchId,
            name: doctor.name ?? `Doctor ${doctor.id}`,
            description: `Consultation queue for Dr. ${doctor.name}`,
            doctorId: doctor.id,
            purpose: QueuePurpose.DOCTOR,
          }),
        { doctorId: doctor.id }
      );
    }

    logger.info("Queue setup: Created default configs", {
      clinicId,
      branchId,
      created: configs.length,
    });

    return { created: configs.length, configs };
  },
};
