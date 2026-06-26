import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "@/lib/app-error";
import {
  invalidateInventoryRelatedCaches,
  invalidateVisitRelatedCaches,
} from "@/lib/cache-utils";
import { searchParamsSchema } from "@/lib/common-validation";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { getScope } from "@/lib/request-scope";
import {
  CareStage,
  DispenseOrderSource,
  PrescriptionItemFulfilment,
  PrescriptionStatus,
  type Prisma,
  QueuePurpose,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { emitFlowUpdate } from "../../../services/flow-events.service";
import {
  type AutoCompletedVisit,
  deletePrescriptionItemMap,
  executeDispense,
  upsertPrescriptionItemMap,
} from "../../../services/pharmacy-dispense.service";
import { QueueIntegrationService } from "../../../services/queue-integration.service";
import type { PharmacyDispenseInput } from "./pharmacy.validation.ts";

function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string
) {
  return c.json({ error: { code, message } }, status);
}

function getPrescriptionBranchScope(branchId?: number) {
  if (typeof branchId !== "number") {
    return {};
  }

  return {
    OR: [
      { branchId },
      {
        branchId: null,
        visit: {
          branchId,
        },
      },
    ],
  };
}

function visitPatientWhereFromSearch(patient: string): Prisma.VisitWhereInput {
  const decodedPatient = patient.replace(/\+/g, " ");
  const searchTerms = decodedPatient
    .split(" ")
    .filter((term) => term.length > 0);

  if (searchTerms.length === 0) {
    return {};
  }

  const queryMode: Prisma.QueryMode = "insensitive";

  if (searchTerms.length === 1) {
    const term = searchTerms[0] as string;
    return {
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    };
  }

  return {
    AND: searchTerms.map((term) => ({
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    })),
  };
}

function patientWhereFromSearch(
  patient: string
): Prisma.PharmacyDispenseOrderWhereInput {
  const decodedPatient = patient.replace(/\+/g, " ");
  const searchTerms = decodedPatient
    .split(" ")
    .filter((term) => term.length > 0);

  if (searchTerms.length === 0) {
    return {};
  }

  const queryMode: Prisma.QueryMode = "insensitive";

  if (searchTerms.length === 1) {
    const term = searchTerms[0] as string;
    return {
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    };
  }

  return {
    AND: searchTerms.map((term) => ({
      patient: {
        OR: [
          { firstName: { contains: term, mode: queryMode } },
          { lastName: { contains: term, mode: queryMode } },
        ],
      },
    })),
  };
}

function getDateTimeWhere(
  _field: "createdAt" | "updatedAt",
  from?: string,
  to?: string
): Prisma.DateTimeFilter | undefined {
  if (from === undefined && to === undefined) {
    return;
  }

  const dateTime: Prisma.DateTimeFilter = {};

  if (from) {
    dateTime.gte = new Date(`${from}T00:00:00.000Z`);
  }

  if (to) {
    dateTime.lte = new Date(`${to}T23:59:59.999Z`);
  }

  return dateTime;
}

function getQueueExtraWhere(params: {
  patient?: string;
  status?: string;
  doctorId?: string;
  from?: string;
  to?: string;
}): Prisma.PrescriptionWhereInput {
  const clauses: Prisma.PrescriptionWhereInput[] = [];

  if (params.status) {
    const statuses = params.status
      .split(".")
      .filter(Boolean) as PrescriptionStatus[];
    if (statuses.length > 0) {
      clauses.push({ status: { in: statuses } });
    }
  }

  if (params.doctorId) {
    clauses.push({ doctorId: Number(params.doctorId) });
  }

  if (params.patient) {
    const patientWhere = visitPatientWhereFromSearch(params.patient);
    if (Object.keys(patientWhere).length > 0) {
      clauses.push({ visit: patientWhere });
    }
  }

  const updatedAt = getDateTimeWhere("updatedAt", params.from, params.to);
  if (updatedAt) {
    clauses.push({ updatedAt });
  }

  if (clauses.length === 0) {
    return {};
  }

  if (clauses.length === 1) {
    return clauses[0] as Prisma.PrescriptionWhereInput;
  }

  return { AND: clauses };
}

function getDispenseOrdersExtraWhere(params: {
  patient?: string;
  from?: string;
  to?: string;
}): Prisma.PharmacyDispenseOrderWhereInput {
  const clauses: Prisma.PharmacyDispenseOrderWhereInput[] = [];

  if (params.patient) {
    const patientWhere = patientWhereFromSearch(params.patient);
    if (Object.keys(patientWhere).length > 0) {
      clauses.push(patientWhere);
    }
  }

  const createdAt = getDateTimeWhere("createdAt", params.from, params.to);
  if (createdAt) {
    clauses.push({ createdAt });
  }

  if (clauses.length === 0) {
    return {};
  }

  if (clauses.length === 1) {
    return clauses[0] as Prisma.PharmacyDispenseOrderWhereInput;
  }

  return { AND: clauses };
}

function mergeWhere<T extends object>(base: T, extra: T): T {
  if (Object.keys(extra).length === 0) {
    return base;
  }

  if (Object.keys(base).length === 0) {
    return extra;
  }

  return { AND: [base, extra] } as T;
}

export const getPharmacyDispenseOrders = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const sourceParam = c.req.query("source");
    const sourceFilter =
      sourceParam &&
      Object.values(DispenseOrderSource).includes(
        sourceParam as DispenseOrderSource
      )
        ? (sourceParam as DispenseOrderSource)
        : undefined;

    const page = params.page;
    const perPage = params.per_page;
    const skip = (page - 1) * perPage;

    const where = mergeWhere<Prisma.PharmacyDispenseOrderWhereInput>(
      {
        clinicId,
        ...(typeof branchId === "number" ? { branchId } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
      },
      getDispenseOrdersExtraWhere({
        patient: params.patient,
        from: params.from,
        to: params.to,
      })
    );

    const [total, rows] = await Promise.all([
      db.pharmacyDispenseOrder.count({ where }),
      db.pharmacyDispenseOrder.findMany({
        where,
        skip,
        take: perPage,
        orderBy: { createdAt: "desc" },
        include: {
          lines: {
            include: {
              inventoryItem: { select: { id: true, itemName: true } },
            },
          },
          prescription: { select: { id: true, visitId: true } },
          patient: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);

    const pageCount = perPage > 0 ? Math.ceil(total / perPage) : 0;

    return c.json({ data: rows, totalCount: total, pageCount });
  } catch (error) {
    logger.error("getPharmacyDispenseOrders", { error });
    return c.json(
      { error: "Failed to load dispense orders" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPharmacyQueue = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const page = params.page;
    const perPage = params.per_page;
    const skip = (page - 1) * perPage;
    const where = mergeWhere<Prisma.PrescriptionWhereInput>(
      {
        clinicId,
        status: {
          in: [PrescriptionStatus.ISSUED, PrescriptionStatus.PARTIALLY_SERVED],
        },
        // Only show prescriptions that have something to dispense from clinic
        // stock; fully-external prescriptions never enter the pharmacy queue.
        items: { some: { fulfilment: PrescriptionItemFulfilment.INTERNAL } },
        ...getPrescriptionBranchScope(branchId),
      },
      getQueueExtraWhere({
        patient: params.patient,
        status: params.status,
        doctorId: params.doctorId,
        from: params.from,
        to: params.to,
      })
    );

    const [total, rows] = await Promise.all([
      db.prescription.count({ where }),
      db.prescription.findMany({
        where,
        skip,
        take: perPage,
        orderBy: { updatedAt: "desc" },
        include: {
          visit: {
            select: {
              id: true,
              patient: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  phoneNumber: true,
                },
              },
            },
          },
          doctor: { select: { id: true, name: true } },
          items: {
            include: {
              pharmacyItemMap: {
                include: {
                  inventoryItem: {
                    select: { id: true, itemName: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    const prescriptionIds = rows.map((r) => r.id);
    const dispensedLines =
      prescriptionIds.length === 0
        ? []
        : await db.pharmacyDispenseLine.findMany({
            where: {
              prescriptionItem: { prescriptionId: { in: prescriptionIds } },
            },
            select: { prescriptionItemId: true },
            distinct: ["prescriptionItemId"],
          });
    const dispensedItemIds = new Set(
      dispensedLines
        .map((d) => d.prescriptionItemId)
        .filter((id): id is number => typeof id === "number")
    );

    const data = rows.map((rx) => ({
      id: rx.id,
      status: rx.status,
      visitId: rx.visitId,
      branchId: rx.branchId,
      updatedAt: rx.updatedAt,
      doctor: rx.doctor,
      patient: rx.visit?.patient ?? null,
      items: rx.items.map((it) => ({
        id: it.id,
        medicationName: it.medicationName,
        dosage: it.dosage,
        frequency: it.frequency,
        duration: it.duration,
        fulfilment: it.fulfilment,
        mappedInventoryItemId: it.pharmacyItemMap?.inventoryItemId ?? null,
        mappedItemName: it.pharmacyItemMap?.inventoryItem.itemName ?? null,
        isDispensed: dispensedItemIds.has(it.id),
      })),
    }));

    const pageCount = perPage > 0 ? Math.ceil(total / perPage) : 0;

    return c.json({
      data,
      totalCount: total,
      pageCount,
    });
  } catch (error) {
    logger.error("getPharmacyQueue", { error });
    return c.json(
      { error: "Failed to load pharmacy queue" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPharmacyPrescriptionDetail = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const prescriptionId = Number.parseInt(c.req.param("prescriptionId"), 10);
    if (!Number.isFinite(prescriptionId)) {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "INVALID_ID",
        "Invalid prescription id"
      );
    }

    const rx = await db.prescription.findFirst({
      where: {
        id: prescriptionId,
        clinicId,
        ...getPrescriptionBranchScope(branchId),
      },
      include: {
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                dateOfBirth: true,
              },
            },
          },
        },
        doctor: { select: { id: true, name: true } },
        items: {
          include: {
            pharmacyItemMap: {
              include: {
                inventoryItem: {
                  select: {
                    id: true,
                    itemName: true,
                    unitPrice: true,
                    itemType: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!rx) {
      return c.json(
        { error: "Not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const dispensed = await db.pharmacyDispenseLine.findMany({
      where: {
        prescriptionItem: { prescriptionId },
      },
      select: { prescriptionItemId: true },
      distinct: ["prescriptionItemId"],
    });
    const dispensedSet = new Set(
      dispensed
        .map((d) => d.prescriptionItemId)
        .filter((id): id is number => typeof id === "number")
    );

    const batchesByItemId = new Map<
      number,
      {
        id: number;
        batchNumber: string;
        currentQuantity: number;
        expiryDate: Date | null;
      }[]
    >();

    for (const it of rx.items) {
      const invId = it.pharmacyItemMap?.inventoryItemId;
      if (typeof invId !== "number") {
        continue;
      }
      const batches = await db.inventoryBatch.findMany({
        where: {
          itemId: invId,
          currentQuantity: { gt: 0 },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
        orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
        select: {
          id: true,
          batchNumber: true,
          currentQuantity: true,
          expiryDate: true,
        },
      });
      batchesByItemId.set(invId, batches);
    }

    return c.json({
      prescription: {
        id: rx.id,
        status: rx.status,
        visitId: rx.visitId,
        branchId: rx.branchId,
        createdAt: rx.createdAt,
        updatedAt: rx.updatedAt,
        doctor: rx.doctor,
        patient: rx.visit?.patient ?? null,
        items: rx.items.map((it) => ({
          id: it.id,
          medicationName: it.medicationName,
          dosage: it.dosage,
          frequency: it.frequency,
          duration: it.duration,
          instructions: it.instructions,
          fulfilment: it.fulfilment,
          quantity: it.quantity,
          mappedInventoryItem: it.pharmacyItemMap?.inventoryItem ?? null,
          isDispensed: dispensedSet.has(it.id),
          availableBatches:
            batchesByItemId.get(it.pharmacyItemMap?.inventoryItemId ?? 0) ?? [],
        })),
      },
    });
  } catch (error) {
    logger.error("getPharmacyPrescriptionDetail", { error });
    return c.json(
      { error: "Failed to load prescription" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Best-effort side-effects after a dispense auto-completes a visit (its last
 * clinic-stock line was just served). The visit row was already moved to DONE
 * inside the dispense transaction; here we only mirror the non-transactional
 * fan-out the manual `/advance` endpoint performs — mark the pharmacy queue
 * entry served, bust visit caches, and push a live flow event so the pipeline
 * UI drops the patient from the Pharmacy column immediately. None of these may
 * fail the already-committed dispense.
 */
const onVisitAutoCompleted = async (
  visit: AutoCompletedVisit,
  actorId?: number
) => {
  try {
    await QueueIntegrationService.markQueueEntryServedForVisit(
      visit.id,
      QueuePurpose.PHARMACY
    );
  } catch {
    /* best-effort */
  }
  try {
    await invalidateVisitRelatedCaches({
      clinicId: visit.clinicId,
      branchId: visit.branchId ?? undefined,
      visitId: visit.id,
      patientId: visit.patientId,
      doctorId: visit.doctorId ?? undefined,
    });
  } catch {
    /* best-effort */
  }
  emitFlowUpdate({
    clinicId: visit.clinicId,
    branchId: visit.branchId ?? undefined,
    type: "visit.advanced",
    fromStage: CareStage.PHARMACY,
    toStage: CareStage.DONE,
    actorId,
  });
};

export const postPharmacyDispense = async (c: Context) => {
  try {
    const user = c.get("user");
    const clinicId = c.get("clinicId");
    const branchId = c.get("branchId");
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const body = c.get("validatedJson") as PharmacyDispenseInput;

    const result = await executeDispense({
      user,
      clinicId,
      branchId,
      source: body.source,
      prescriptionId: body.prescriptionId,
      visitId: body.visitId,
      patientId: body.patientId,
      externalPrescriberName: body.externalPrescriberName,
      externalPrescriptionDate: body.externalPrescriptionDate ?? null,
      notes: body.notes,
      lines: body.lines,
      idempotencyKey: body.idempotencyKey,
    });

    await invalidateInventoryRelatedCaches({ clinicId, branchId });

    if (result.autoCompletedVisit) {
      await onVisitAutoCompleted(
        result.autoCompletedVisit,
        typeof user?.id === "number" ? user.id : undefined
      );
    }

    const status = result.replayed ? httpCodes.OK : httpCodes.CREATED;

    return c.json(
      {
        order: result.order,
        replayed: result.replayed,
      },
      status as ContentfulStatusCode
    );
  } catch (error) {
    if (error instanceof AppError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.exposeMessage ? error.message : "Request failed",
          },
        },
        error.status as ContentfulStatusCode
      );
    }
    logger.error("postPharmacyDispense", { error });
    return c.json(
      { error: "Dispense failed" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const mapPrescriptionItemToInventory = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const branchId = c.get("branchId");
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const prescriptionItemId = Number.parseInt(
      c.req.param("prescriptionItemId"),
      10
    );
    if (!Number.isFinite(prescriptionItemId)) {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "INVALID_ID",
        "Invalid prescription item id"
      );
    }

    const body = c.get("validatedJson") as { inventoryItemId: number };

    const map = await upsertPrescriptionItemMap({
      clinicId,
      branchId,
      prescriptionItemId,
      inventoryItemId: body.inventoryItemId,
    });

    return c.json({ map });
  } catch (error) {
    if (error instanceof AppError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.exposeMessage ? error.message : "Request failed",
          },
        },
        error.status as ContentfulStatusCode
      );
    }
    logger.error("mapPrescriptionItemToInventory", { error });
    return c.json(
      { error: "Map failed" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deletePrescriptionItemMapping = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const branchId = c.get("branchId");
    if (typeof clinicId !== "number") {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "CLINIC_REQUIRED",
        "clinicId is required"
      );
    }

    const prescriptionItemId = Number.parseInt(
      c.req.param("prescriptionItemId"),
      10
    );
    if (!Number.isFinite(prescriptionItemId)) {
      return jsonError(
        c,
        httpCodes.BAD_REQUEST as ContentfulStatusCode,
        "INVALID_ID",
        "Invalid prescription item id"
      );
    }

    await deletePrescriptionItemMap({
      clinicId,
      prescriptionItemId,
      branchId,
    });
    return c.body(null, httpCodes.NO_CONTENT as ContentfulStatusCode);
  } catch (error) {
    if (error instanceof AppError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.exposeMessage ? error.message : "Request failed",
          },
        },
        error.status as ContentfulStatusCode
      );
    }
    logger.error("deletePrescriptionItemMapping", { error });
    return c.json(
      { error: "Delete failed" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
