import { z } from "zod";
import { ExamStatus } from "../../../../generated/prisma";

export const getExamParamsSchema = z.object({ id: z.string() });
export const getExamResultParamsSchema = z.object({ id: z.string() });
export const getExamTestParamsSchema = z.object({ id: z.string() });
export const getVisitIdParamsSchema = z.object({ visitId: z.string() });

export type GetExamParams = z.infer<typeof getExamParamsSchema>;
export type GetExamResultParams = z.infer<typeof getExamResultParamsSchema>;
export type GetExamTestParams = z.infer<typeof getExamTestParamsSchema>;
export type GetVisitIdParams = z.infer<typeof getVisitIdParamsSchema>;

export const parameterSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  unit: z.string().optional(),
  referenceRange: z.string().optional(),
});

export const examResultSchema = z.object({
  productName: z.string().min(1, "Product name is required"),
  parameters: z.array(parameterSchema).optional(),
  conclusion: z.string().optional(),
  notes: z.string().optional(),
});

export const createExamSchema = z.object({
  visitId: z.number().int().positive(),
  name: z.string().optional(),
  description: z.string().optional(),
  productIds: z
    .array(z.number().int().positive())
    .min(1, "At least one product is required"),
});

export const updateExamSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(ExamStatus).optional(),
});

export const createExamResultSchema = z.object({
  visitId: z.number().int().positive(),
  examId: z.number().int().positive(),
  examDate: z.string().datetime().optional(),
  results: examResultSchema,
  notes: z.string().optional(),
});

export const updateExamResultSchema = z.object({
  results: examResultSchema.optional(),
  notes: z.string().optional(),
});

export const createExamTestSchema = z.object({
  name: z.string().min(1, "Test name is required"),
  description: z.string().optional(),
  normalRange: z.string().optional(),
  unit: z.string().optional(),
  productId: z.number().int().positive(),
  examId: z.number().int().positive().optional(),
  consumables: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z
          .string()
          .refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, {
            message: "Quantity must be a positive number",
          }),
      })
    )
    .optional(),
});

export const updateExamTestSchema = z.object({
  name: z.string().min(1, "Test name is required").optional(),
  description: z.string().optional(),
  normalRange: z.string().optional(),
  unit: z.string().optional(),
  consumables: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z
          .string()
          .refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, {
            message: "Quantity must be a positive number",
          }),
      })
    )
    .optional(),
});

export const updateExamTestUnitsSchema = z.object({
  unit: z.string().min(1, "Units cannot be empty").nullable(),
});

export const updateExamTestNormalRangeSchema = z.object({
  normalRange: z.string().min(1, "Normal range cannot be empty").nullable(),
});

export const updateExamTestConsumablesSchema = z.object({
  consumables: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z
          .string()
          .refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, {
            message: "Quantity must be a positive number",
          }),
      })
    )
    .nullable(),
});

export type CreateExamData = z.infer<typeof createExamSchema>;
export type UpdateExamData = z.infer<typeof updateExamSchema>;
export type CreateExamResultData = z.infer<typeof createExamResultSchema>;
export type UpdateExamResultData = z.infer<typeof updateExamResultSchema>;
export type CreateExamTestData = z.infer<typeof createExamTestSchema>;
export type UpdateExamTestData = z.infer<typeof updateExamTestSchema>;
export type ExamResultData = z.infer<typeof examResultSchema>;
