import { z } from "zod";
import { DispenseOrderSource } from "../../../../generated/prisma/client";

const dispenseOrderSourceSchema = z.nativeEnum(DispenseOrderSource);

const dispenseLineSchema = z.object({
  inventoryItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive(),
  batchId: z.coerce.number().int().positive().optional(),
  prescriptionItemId: z.coerce.number().int().positive().optional(),
});

export const pharmacyDispenseSchema = z
  .object({
    source: dispenseOrderSourceSchema,
    prescriptionId: z.coerce.number().int().positive().optional().nullable(),
    visitId: z.coerce.number().int().positive().optional().nullable(),
    patientId: z.coerce.number().int().positive().optional().nullable(),
    externalPrescriberName: z.string().max(500).optional().nullable(),
    externalPrescriptionDate: z.coerce.date().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    lines: z.array(dispenseLineSchema).min(1),
    idempotencyKey: z.string().min(8).max(128).optional().nullable(),
  })
  .strict();

export const mapPrescriptionItemSchema = z
  .object({
    inventoryItemId: z.coerce.number().int().positive(),
  })
  .strict();

export type PharmacyDispenseInput = z.infer<typeof pharmacyDispenseSchema>;
