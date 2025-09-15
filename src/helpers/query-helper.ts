import type { ParamsSchema } from "../lib/common-validation";
import type { Gender, Role } from "../../generated/prisma";
import { parseISO, format } from "date-fns";

type SortableEntity = {
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
};

export function buildQueryOptions<T extends SortableEntity>(
  params: ParamsSchema,
  additionalWhere: Record<string, unknown> = {},
): {
  skip?: number;
  take?: number;
  orderBy: Record<string, "asc" | "desc">;
  where: Record<string, unknown>;
} {
  const { page, per_page, sort, from, to, ...filterParams } = params;

  const paginationOptions = getPaginationOptions(page, per_page);
  const orderByOptions = getSortOptions<T>(sort);
  const whereConditions = getWhereConditions(filterParams, from, to);

  return {
    ...paginationOptions,
    orderBy: orderByOptions,
    where: { ...additionalWhere, ...whereConditions },
  };
}

function getPaginationOptions(
  page?: number,
  per_page?: number,
): {
  skip?: number;
  take?: number;
} {
  return {
    skip: page && per_page ? (page - 1) * per_page : undefined,
    take: per_page,
  };
}

function getSortOptions<T>(sort?: string): Record<string, "asc" | "desc"> {
  const [column, order] = (sort?.split(".").filter(Boolean) ?? [
    "updatedAt",
    "desc",
  ]) as [keyof T | undefined, "asc" | "desc" | undefined];

  const direction: "asc" | "desc" = order === "desc" ? "desc" : "asc";
  return column ? { [String(column)]: direction } : { updatedAt: "desc" };
}

function getWhereConditions(
  {
    name,
    status,
    role,
    gender,
    patient,
    doctorId,
    clinicId,
    branchId,
    itemName,
    itemType,
    insuranceCompany,
    processedById,
  }: Partial<ParamsSchema>,
  from?: string,
  to?: string,
): Record<string, unknown> {
  const whereConditions = {
    ...getNameCondition(name),
    ...getPatientNameCondition(patient),
    ...getDateCondition(from, to),
    ...getStatusCondition(status),
    ...getRoleCondition(role),
    ...getGenderCondition(gender),
    ...getDoctorIdCondition(doctorId),
    ...getClinicIdCondition(clinicId),
    ...getBranchIdCondition(branchId),
    ...getItemNameCondition(itemName),
    ...getItemTypeCondition(itemType),
    ...getInsuranceCompanyCondition(insuranceCompany),
    ...getProcessedByIdCondition(processedById),
  };
  return whereConditions;
}

function getProcessedByIdCondition(processedById?: string) {
  return processedById ? { processedById: +processedById } : {};
}

function getNameCondition(name?: string) {
  if (!name) return {};
  const searchTerms = name.split(" ").filter((term) => term.length > 2);
  return {
    OR: [
      { name: { equals: name, mode: "insensitive" } },
      { name: { contains: name, mode: "insensitive" } },
      ...searchTerms.map((term) => ({
        name: { contains: term, mode: "insensitive" },
      })),
    ],
  };
}

function getPatientNameCondition(patient?: string) {
  return patient
    ? {
        OR: [
          {
            patient: { firstName: { contains: patient, mode: "insensitive" } },
          },
          { patient: { lastName: { contains: patient, mode: "insensitive" } } },
        ],
      }
    : {};
}

function getDateCondition(from?: string, to?: string) {
  const fromDay = from ? parseISO(from) : undefined;
  const toDay = to ? parseISO(to) : undefined;

  if (fromDay) {
    // Set to start of day in local time, then format to UTC
    const fromStart = new Date(
      format(fromDay, "yyyy-MM-dd") + "T00:00:00.000Z",
    );
    fromDay.setTime(fromStart.getTime());
  }

  if (toDay) {
    // Set to end of day in local time, then format to UTC
    const toEnd = new Date(format(toDay, "yyyy-MM-dd") + "T23:59:59.999Z");
    toDay.setTime(toEnd.getTime());
  }

  return fromDay && toDay
    ? {
        AND: [
          { createdAt: { gte: fromDay.toISOString() } },
          { createdAt: { lte: toDay.toISOString() } },
        ],
      }
    : {};
}

function getStatusCondition(status?: string): {
  OR?: Array<{ status: unknown }>;
} {
  const statusArray = status?.split(".");
  return statusArray
    ? { OR: statusArray.map((s) => ({ status: s as unknown })) }
    : {};
}

function getRoleCondition(role?: string) {
  const roleArray = role?.split(".");
  return roleArray
    ? { OR: roleArray.map((role) => ({ role: role as Role })) }
    : {};
}

function getGenderCondition(gender?: string) {
  return gender ? { patient: { gender: gender as Gender } } : {};
}

function getDoctorIdCondition(doctorId?: string) {
  return doctorId
    ? {
        OR: [
          { doctorId: +doctorId },
          { handoffs: { some: { toDoctorId: +doctorId } } },
        ],
      }
    : {};
}

function getClinicIdCondition(clinicId?: string) {
  return clinicId ? { clinicId: +clinicId } : {};
}

function getBranchIdCondition(branchId?: string) {
  return branchId ? { branchId: +branchId } : {};
}

function getItemNameCondition(itemName?: string) {
  return itemName
    ? { itemName: { contains: itemName, mode: "insensitive" } }
    : {};
}

function getItemTypeCondition(itemType?: string) {
  const selectedItemType = itemType?.split(".");
  return itemType ? { itemType: { in: selectedItemType } } : {};
}

function getInsuranceCompanyCondition(insuranceCompany?: string) {
  return insuranceCompany
    ? {
        patientInsurance: {
          insuranceCompany: {
            companyName: { contains: insuranceCompany, mode: "insensitive" },
          },
        },
      }
    : {};
}
