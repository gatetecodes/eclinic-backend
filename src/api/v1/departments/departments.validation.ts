import { z } from "zod";

export const getDepartmentParamsSchema = z.object({ id: z.string() });

export const getClinicIdParamsSchema = z.object({ clinicId: z.string() });

export type GetDepartmentParams = z.infer<typeof getDepartmentParamsSchema>;
export type GetClinicIdParams = z.infer<typeof getClinicIdParamsSchema>;

export const createDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required"),
  isActive: z.boolean().optional().default(true),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required").optional(),
  isActive: z.boolean().optional(),
});

export const createClinicDepartmentsSchema = z.object({
  departments: z
    .array(z.string())
    .min(1, { message: "Departments are required" }),
});

export type CreateDepartmentData = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentData = z.infer<typeof updateDepartmentSchema>;
export type CreateClinicDepartmentsData = z.infer<
  typeof createClinicDepartmentsSchema
>;
