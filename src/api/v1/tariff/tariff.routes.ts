import { Hono } from "hono";
import { validate } from "../../../middlewares/validation.middleware";
import {
  createProduct,
  getConsultationProducts,
  getConsultationProductsWithPricing,
  getProductById,
  getProductsList,
  getProductsListWithPricing,
  getTariff,
  importProductsFromCSV,
  updateProduct,
  updateProductPricing,
} from "./tariff.controller";
import {
  createProductSchema,
  getProductParamsSchema,
  importProductsSchema,
  updateProductPricingSchema,
  updateProductSchema,
} from "./tariff.validation";

const tariffRouter = new Hono();

// Tariff routes
tariffRouter.get("/", getTariff);

// Product routes
tariffRouter.get("/products", getProductsList);
tariffRouter.get("/products/with-pricing", getProductsListWithPricing);
tariffRouter.get("/products/consultations", getConsultationProducts);
tariffRouter.get(
  "/products/consultations/with-pricing",
  getConsultationProductsWithPricing
);
tariffRouter.post(
  "/products",
  validate(createProductSchema, "json"),
  createProduct
);
tariffRouter.post(
  "/products/import-csv",
  validate(importProductsSchema, "json"),
  importProductsFromCSV
);

// Product by ID routes
tariffRouter.get(
  "/products/:id",
  validate(getProductParamsSchema, "param"),
  getProductById
);
tariffRouter.put(
  "/products/:id",
  validate(getProductParamsSchema, "param"),
  validate(updateProductSchema, "json"),
  updateProduct
);
tariffRouter.put(
  "/products/:id/pricing",
  validate(getProductParamsSchema, "param"),
  validate(updateProductPricingSchema, "json"),
  updateProductPricing
);

export default tariffRouter;
