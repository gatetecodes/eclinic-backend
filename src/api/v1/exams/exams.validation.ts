import { z } from "zod";
import { ExamStatus } from "../../../../generated/prisma/client";

const optionalNullableText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

export const getExamParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "ID must be a number"),
});
export const getExamResultParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "ID must be a number"),
});
export const getExamTestParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "ID must be a number"),
});
export const getVisitIdParamsSchema = z.object({ visitId: z.string() });

export type GetExamParams = z.infer<typeof getExamParamsSchema>;
export type GetExamResultParams = z.infer<typeof getExamResultParamsSchema>;
export type GetExamTestParams = z.infer<typeof getExamTestParamsSchema>;
export type GetVisitIdParams = z.infer<typeof getVisitIdParamsSchema>;

export const parameterSchema = z.object({
  name: optionalNullableText,
  value: z.string().trim().min(1, "Result value is required"),
  unit: optionalNullableText,
  referenceRange: optionalNullableText,
});

export const examResultSchema = z.object({
  productName: z.string().min(1, "Product name is required"),
  parameters: z.array(parameterSchema).optional(),
  conclusion: optionalNullableText,
  notes: optionalNullableText,
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
  productName: z.string().min(1, "Product name is required"),
  parameters: z.array(parameterSchema).optional(),
  conclusion: optionalNullableText,
  notes: optionalNullableText,
});

export const updateExamResultSchema = z.object({
  productName: z.string().min(1, "Product name is required").optional(),
  parameters: z.array(parameterSchema).optional(),
  conclusion: optionalNullableText,
  notes: optionalNullableText,
});

const consumablesSchema = z
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
  .optional();

const nullableNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .pipe(z.union([z.number().finite(), z.string(), z.null(), z.undefined()]))
  .transform((value, ctx) => {
    if (value === undefined) {
      return;
    }
    if (value === null) {
      return null;
    }
    if (typeof value === "number") {
      return value;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: "custom",
        message: "Must be a valid number",
      });
      return z.NEVER;
    }
    return n;
  });

const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

// Structured result-flagging config shared by create / update / bulk schemas.
const examTestConfigShape = {
  specimen: nullableText,
  testType: z.enum(["NUMERIC", "QUALITATIVE"]).optional(),
  referenceLow: nullableNumber,
  referenceHigh: nullableNumber,
  criticalLow: nullableNumber,
  criticalHigh: nullableNumber,
  qualitativeExpected: nullableText,
};

const examTestNumericBounds = [
  "referenceLow",
  "referenceHigh",
  "criticalLow",
  "criticalHigh",
] as const;

type ExamTestNumericBound = (typeof examTestNumericBounds)[number];

type ExamTestConfigRuleData = Partial<
  Record<ExamTestNumericBound, number | null | undefined>
> & {
  testType?: "NUMERIC" | "QUALITATIVE";
  qualitativeExpected?: string | null;
};

type ExamTestConfigIssue = (path: string, message: string) => void;

const validateNumericBoundRules = (
  data: ExamTestConfigRuleData,
  addIssue: ExamTestConfigIssue
) => {
  const boundRules = [
    {
      path: "referenceLow",
      lower: "referenceLow",
      upper: "referenceHigh",
      isInvalid: (lower: number, upper: number) => lower > upper,
      message: "Reference low cannot exceed reference high",
    },
    {
      path: "criticalLow",
      lower: "criticalLow",
      upper: "criticalHigh",
      isInvalid: (lower: number, upper: number) => lower > upper,
      message: "Critical low cannot exceed critical high",
    },
    {
      path: "criticalLow",
      lower: "criticalLow",
      upper: "referenceLow",
      isInvalid: (lower: number, upper: number) => lower > upper,
      message: "Critical low must be less than reference low",
    },
    {
      path: "criticalHigh",
      lower: "criticalHigh",
      upper: "referenceHigh",
      isInvalid: (lower: number, upper: number) => lower < upper,
      message: "Critical high must exceed reference high",
    },
  ] as const;

  for (const rule of boundRules) {
    const lower = data[rule.lower];
    const upper = data[rule.upper];
    if (lower != null && upper != null && rule.isInvalid(lower, upper)) {
      addIssue(rule.path, rule.message);
    }
  }
};

const validateTestTypeRules = (
  data: ExamTestConfigRuleData,
  addIssue: ExamTestConfigIssue
) => {
  const effectiveTestType = data.testType ?? "NUMERIC";

  if (
    effectiveTestType === "QUALITATIVE" &&
    examTestNumericBounds.some((key) => data[key] != null)
  ) {
    addIssue(
      "testType",
      "Qualitative tests cannot use numeric reference or critical bounds"
    );
  }

  if (effectiveTestType === "NUMERIC" && data.qualitativeExpected) {
    addIssue(
      "qualitativeExpected",
      "Numeric tests cannot use a qualitative expected value"
    );
  }
};

const withExamTestConfigRules = <T extends z.ZodRawShape>(
  schema: z.ZodObject<T>
) =>
  schema.superRefine((data, ctx) => {
    const examTestConfig = data as ExamTestConfigRuleData;
    const addIssue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    validateNumericBoundRules(examTestConfig, addIssue);
    validateTestTypeRules(examTestConfig, addIssue);
  });

export const createExamTestSchema = withExamTestConfigRules(
  z.object({
    name: z.string().min(1, "Test name is required"),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().optional(),
    productId: z.number().int().positive(),
    examId: z.number().int().positive().optional(),
    consumables: consumablesSchema,
    ...examTestConfigShape,
  })
);

export const updateExamTestSchema = withExamTestConfigRules(
  z.object({
    name: z.string().min(1, "Test name is required").optional(),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().optional(),
    consumables: consumablesSchema,
    ...examTestConfigShape,
  })
);

// Batch save from the Tests Management screen: one entry per edited test.
export const bulkUpdateExamTestsSchema = z.object({
  tests: z
    .array(
      withExamTestConfigRules(
        z.object({
          id: z.number().int().positive(),
          unit: nullableText,
          ...examTestConfigShape,
        })
      )
    )
    .min(1, "At least one test is required"),
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
export type BulkUpdateExamTestsData = z.infer<typeof bulkUpdateExamTestsSchema>;
export type ExamResultData = z.infer<typeof examResultSchema>;
