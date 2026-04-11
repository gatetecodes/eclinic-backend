import type { User } from "@/lib/auth";
import type { DispenseOrderSource } from "../../generated/prisma/client";

export type DispenseLineInput = {
  inventoryItemId: number;
  quantity: number;
  batchId?: number;
  prescriptionItemId?: number;
};

export type ExecuteDispenseParams = {
  user: User;
  clinicId: number;
  branchId: number | undefined;
  source: DispenseOrderSource;
  prescriptionId?: number | null;
  visitId?: number | null;
  patientId?: number | null;
  externalPrescriberName?: string | null;
  externalPrescriptionDate?: Date | null;
  notes?: string | null;
  lines: DispenseLineInput[];
  idempotencyKey?: string | null;
};
