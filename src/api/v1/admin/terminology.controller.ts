import type { Context } from "hono";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { writeAudit } from "@/services/audit.service";
import { terminologyVerificationFields } from "@/services/hie/product-terminology.service";

type TerminologyQuery = {
  page: number;
  per_page: number;
  search?: string;
  status?: "DRAFT" | "VERIFIED";
};

type TerminologyUpdate = {
  icd11Code: string | null;
  loincCode: string | null;
  snomedCode: string | null;
  rxNormCode: string | null;
  ichiCode: string | null;
  nationalTariffCode: string | null;
  status: "DRAFT" | "VERIFIED";
};

const terminologySelect = {
  id: true,
  code: true,
  name: true,
  category: true,
  icd11Code: true,
  loincCode: true,
  snomedCode: true,
  rxNormCode: true,
  ichiCode: true,
  nationalTariffCode: true,
  terminologyStatus: true,
  terminologyVerifiedAt: true,
  terminologyVerifiedBy: { select: { id: true, name: true } },
  updatedAt: true,
} as const;

export async function listProductTerminology(c: Context<AppEnv>) {
  const query = c.get("validatedQuery") as TerminologyQuery;
  const search = query.search?.trim();
  const where = {
    ...(query.status ? { terminologyStatus: query.status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { code: { contains: search, mode: "insensitive" as const } },
            { icd11Code: { contains: search, mode: "insensitive" as const } },
            { loincCode: { contains: search, mode: "insensitive" as const } },
            { snomedCode: { contains: search, mode: "insensitive" as const } },
            { rxNormCode: { contains: search, mode: "insensitive" as const } },
            { ichiCode: { contains: search, mode: "insensitive" as const } },
            {
              nationalTariffCode: {
                contains: search,
                mode: "insensitive" as const,
              },
            },
          ],
        }
      : {}),
  };
  const skip = (query.page - 1) * query.per_page;
  const [products, totalCount] = await Promise.all([
    db.product.findMany({
      where,
      select: terminologySelect,
      orderBy: [{ terminologyStatus: "asc" }, { name: "asc" }],
      skip,
      take: query.per_page,
    }),
    db.product.count({ where }),
  ]);

  return jsonSuccess(c, {
    data: products,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function updateProductTerminology(c: Context<AppEnv>) {
  const { productId } = c.get("validatedParam") as { productId: number };
  const input = c.get("validatedJson") as TerminologyUpdate;
  const actorId = Number(c.get("user").id);
  const existing = await db.product.findUnique({
    where: { id: productId },
    select: { id: true },
  });
  if (!existing) {
    throw notFoundError("Product not found");
  }

  const product = await db.product.update({
    where: { id: productId },
    data: {
      icd11Code: input.icd11Code,
      loincCode: input.loincCode,
      snomedCode: input.snomedCode,
      rxNormCode: input.rxNormCode,
      ichiCode: input.ichiCode,
      nationalTariffCode: input.nationalTariffCode,
      ...terminologyVerificationFields(input.status, actorId),
    },
    select: terminologySelect,
  });
  if (input.status === "VERIFIED") {
    await db.hieOutboxEvent.updateMany({
      where: {
        status: "BLOCKED",
        OR: [
          {
            dependencyReason:
              "A platform-verified terminology mapping is required",
          },
          { lastErrorCode: "VERIFIED_TERMINOLOGY_REQUIRED" },
        ],
      },
      data: {
        status: "PENDING",
        dependencyReason: null,
        nextAttemptAt: new Date(),
        lockedAt: null,
      },
    });
  }

  await writeAudit(c, "product.terminologyUpdated", {
    targetType: "product",
    targetId: product.id,
    metadata: { terminologyStatus: product.terminologyStatus },
  });

  return jsonSuccess(c, { data: product });
}
