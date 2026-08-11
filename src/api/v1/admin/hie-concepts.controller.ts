import type { Context } from "hono";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { writeAudit } from "@/services/audit.service";
import type {
  HieClinicalConceptDomain,
  ProductTerminologyStatus,
} from "../../../../generated/prisma/client";

type ConceptQuery = {
  page: number;
  per_page: number;
  search?: string;
  domain?: HieClinicalConceptDomain;
  status?: ProductTerminologyStatus;
};

type ConceptInput = {
  domain: HieClinicalConceptDomain;
  codingSystem: string;
  code: string;
  display: string;
  status: ProductTerminologyStatus;
  active: boolean;
};

const select = {
  id: true,
  domain: true,
  codingSystem: true,
  code: true,
  display: true,
  status: true,
  active: true,
  verifiedAt: true,
  verifiedBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const;

export async function listHieClinicalConcepts(c: Context<AppEnv>) {
  const query = c.get("validatedQuery") as ConceptQuery;
  const where = {
    domain: query.domain,
    status: query.status,
    ...(query.search
      ? {
          OR: [
            { code: { contains: query.search, mode: "insensitive" as const } },
            {
              display: {
                contains: query.search,
                mode: "insensitive" as const,
              },
            },
            {
              codingSystem: {
                contains: query.search,
                mode: "insensitive" as const,
              },
            },
          ],
        }
      : {}),
  };
  const [items, totalCount] = await Promise.all([
    db.hieClinicalConcept.findMany({
      where,
      select,
      orderBy: [{ domain: "asc" }, { display: "asc" }],
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieClinicalConcept.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

function verification(input: ConceptInput, actorId: number) {
  return input.status === "VERIFIED"
    ? { verifiedById: actorId, verifiedAt: new Date() }
    : { verifiedById: null, verifiedAt: null };
}

async function ensureConceptCodeAvailable(
  input: ConceptInput,
  excludingId?: number
) {
  const duplicate = await db.hieClinicalConcept.findFirst({
    where: {
      domain: input.domain,
      codingSystem: input.codingSystem,
      code: input.code,
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new AppError({
      status: 409,
      code: "HIE_CONCEPT_CODE_DUPLICATE",
      message: "This coding system and code already exists in the domain",
      exposeMessage: true,
    });
  }
}

export async function createHieClinicalConcept(c: Context<AppEnv>) {
  const input = c.get("validatedJson") as ConceptInput;
  const actorId = Number(c.get("user").id);
  await ensureConceptCodeAvailable(input);
  const concept = await db.hieClinicalConcept.create({
    data: { ...input, ...verification(input, actorId) },
    select,
  });
  await writeAudit(c, "hie.conceptCreated", {
    targetType: "hieClinicalConcept",
    targetId: concept.id,
    metadata: { domain: concept.domain, status: concept.status },
  });
  return jsonSuccess(c, { status: 201, data: concept });
}

export async function updateHieClinicalConcept(c: Context<AppEnv>) {
  const { conceptId } = c.get("validatedParam") as { conceptId: number };
  const input = c.get("validatedJson") as ConceptInput;
  const actorId = Number(c.get("user").id);
  const existing = await db.hieClinicalConcept.findUnique({
    where: { id: conceptId },
    select: { id: true },
  });
  if (!existing) {
    throw notFoundError("HIE clinical concept not found");
  }
  await ensureConceptCodeAvailable(input, conceptId);
  const concept = await db.hieClinicalConcept.update({
    where: { id: conceptId },
    data: { ...input, ...verification(input, actorId) },
    select,
  });
  await writeAudit(c, "hie.conceptUpdated", {
    targetType: "hieClinicalConcept",
    targetId: concept.id,
    metadata: { domain: concept.domain, status: concept.status },
  });
  return jsonSuccess(c, { data: concept });
}
