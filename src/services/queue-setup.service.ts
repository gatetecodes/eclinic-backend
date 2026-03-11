import { db } from "@/database/db";
import { DefaultDepartments } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { QueuePurpose, Role, UserStatus } from "../../generated/prisma/client";
import { QueueConfigService } from "./queue-config.service";

/**
 * Creates default queue configs for a branch when queue management is first enabled.
 * Creates: Single cross-departmental Pre-consultation, Lab queue, Doctor queue per doctor.
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

    const [branch, doctors, existingCount] = await Promise.all([
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
      db.queueConfig.count({ where: { clinicId, branchId } }),
    ]);

    if (!branch) {
      throw new Error("Branch not found");
    }

    if (existingCount > 0) {
      logger.info("Queue setup: Configs already exist, skipping", {
        clinicId,
        branchId,
        existingCount,
      });
      return { created: 0, configs: [] };
    }

    const labDept = await db.clinicalDepartment.findFirst({
      where: { name: DefaultDepartments.LABORATOIRE },
      select: { id: true },
    });

    // Single cross-departmental pre-consultation queue per branch
    try {
      const preConsultConfig = await QueueConfigService.create({
        clinicId,
        branchId,
        name: "Pre-consultation",
        description: "Pre-consultation queue for all departments",
        departmentId: undefined,
        purpose: QueuePurpose.PRE_CONSULTATION,
      });
      configs.push({ id: preConsultConfig.id, name: preConsultConfig.name });
    } catch (err) {
      logger.warn("Queue setup: Failed to create pre-consult config", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Lab queue
    try {
      const labConfig = await QueueConfigService.create({
        clinicId,
        branchId,
        name: "Lab",
        description: "Lab sample collection queue",
        departmentId: labDept?.id,
        purpose: QueuePurpose.LAB,
      });
      configs.push({ id: labConfig.id, name: labConfig.name });
    } catch (err) {
      logger.warn("Queue setup: Failed to create lab config", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Doctor queue per doctor in branch
    for (const doctor of doctors) {
      try {
        const config = await QueueConfigService.create({
          clinicId,
          branchId,
          name: doctor.name ?? `Doctor ${doctor.id}`,
          description: `Consultation queue for Dr. ${doctor.name}`,
          doctorId: doctor.id,
          purpose: QueuePurpose.DOCTOR,
        });
        configs.push({ id: config.id, name: config.name });
      } catch (err) {
        logger.warn("Queue setup: Failed to create doctor config", {
          doctorId: doctor.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Queue setup: Created default configs", {
      clinicId,
      branchId,
      created: configs.length,
    });

    return { created: configs.length, configs };
  },
};
