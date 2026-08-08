import { z } from "zod";

export const getTariffParamsSchema = z.object({ id: z.string() });
export const getProductParamsSchema = z.object({ id: z.string() });

export type GetTariffParams = z.infer<typeof getTariffParamsSchema>;
export type GetProductParams = z.infer<typeof getProductParamsSchema>;

export const editTariffSchema = z.object({
  basePrice: z.coerce.number().min(0, "Base price must be non-negative"),
  insurancePrices: z.array(
    z.object({
      companyId: z.string(),
      price: z.coerce.number().min(0, "Price must be non-negative"),
      priceWithCo: z.coerce
        .number()
        .min(0, "Price with CO must be non-negative"),
      priceType: z.enum(["PRIVATE", "GOV"]).optional(),
      insurerItemCode: z.string().optional(),
    })
  ),
});

export const createProductSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  code: z.string().min(1, "Product code is required"),
  description: z.string().optional(),
  category: z.enum(["TREATMENT", "EXAM", "MEDICATION", "SUPPLY"]).optional(),
  basePrice: z.coerce
    .number()
    .min(0, "Base price must be non-negative")
    .optional(),
  eastAfricaPrice: z.coerce
    .number()
    .min(0, "East Africa price must be non-negative")
    .optional(),
  africaPrice: z.coerce
    .number()
    .min(0, "Africa price must be non-negative")
    .optional(),
  restOfWorldPrice: z.coerce
    .number()
    .min(0, "Rest of World price must be non-negative")
    .optional(),
  unit: z.string().optional(),
  normalRange: z.string().optional(),
  icd11Code: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  loincCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  snomedCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  ichiCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  nationalTariffCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
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
  departmentIds: z.array(z.number().int().positive()).optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1, "Product name is required").optional(),
  code: z.string().min(1, "Product code is required").optional(),
  description: z.string().optional(),
  category: z.enum(["TREATMENT", "EXAM", "MEDICATION", "SUPPLY"]).optional(),
  basePrice: z
    .literal("")
    .transform(() => null)
    .or(z.coerce.number().min(0, "Base price must be non-negative"))
    .optional(),
  eastAfricaPrice: z
    .literal("")
    .transform(() => null)
    .or(z.coerce.number().min(0, "East Africa price must be non-negative"))
    .optional(),
  africaPrice: z
    .literal("")
    .transform(() => null)
    .or(z.coerce.number().min(0, "Africa price must be non-negative"))
    .optional(),
  restOfWorldPrice: z
    .literal("")
    .transform(() => null)
    .or(
      z.coerce.number().min(0, "Rest of the World price must be non-negative")
    )
    .optional(),
  unit: z.string().optional(),
  normalRange: z.string().optional(),
  icd11Code: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  loincCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  snomedCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  ichiCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
  nationalTariffCode: z
    .literal("")
    .transform(() => null)
    .or(z.string())
    .optional(),
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
  departmentIds: z.array(z.number().int().positive()).optional(),
  isActive: z.boolean().optional(),
});

export const importProductsSchema = z.object({
  csvContent: z.string().min(1, "CSV content is required"),
});

export const getProductsByDepartmentSchema = z.object({
  departmentIds: z.array(z.number().int().positive()).optional(),
});

export const updateProductPricingSchema = z.object({
  basePrice: z.coerce.number().min(0, "Base price must be non-negative"),
  icd11Code: z.string().optional(),
  loincCode: z.string().optional(),
  snomedCode: z.string().optional(),
  ichiCode: z.string().optional(),
  nationalTariffCode: z.string().optional(),
  eastAfricaPrice: z.coerce
    .number()
    .min(0, "East Africa price must be non-negative")
    .optional(),
  africaPrice: z.coerce
    .number()
    .min(0, "Africa price must be non-negative")
    .optional(),
  restOfWorldPrice: z.coerce
    .number()
    .min(0, "Rest of World price must be non-negative")
    .optional(),
  insurancePrices: z
    .array(
      z.object({
        companyId: z.string(),
        priceWithCo: z.coerce
          .number()
          .min(0, "Price with CO must be non-negative")
          .optional(),
        priceType: z.enum(["PRIVATE", "GOV"]).optional(),
        price: z.coerce.number().min(0, "Price must be non-negative"),
        insurerItemCode: z.string().optional(),
      })
    )
    .optional(),
});

export type EditTariffData = z.infer<typeof editTariffSchema>;
export type CreateProductData = z.infer<typeof createProductSchema>;
export type UpdateProductData = z.infer<typeof updateProductSchema>;
export type ImportProductsData = z.infer<typeof importProductsSchema>;
export type GetProductsByDepartmentData = z.infer<
  typeof getProductsByDepartmentSchema
>;
export type UpdateProductPricingData = z.infer<
  typeof updateProductPricingSchema
>;
