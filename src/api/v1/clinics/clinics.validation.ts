import { z } from "zod";

export const getClinicParamsSchema = z.object({ id: z.string() });

export type GetClinicParams = z.infer<typeof getClinicParamsSchema>;
