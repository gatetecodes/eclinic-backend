import { differenceInDays } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  ActivityType,
  type Hospitalization,
  type PatientInsurance,
  PaymentMode,
  PaymentType,
  type Prisma,
  type Room,
  type RoomClass,
  type RoomPrice,
  VisitStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { logActivity } from "../../../helpers/activity-helpers";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { addProductSchema } from "./hospitalization.validation";

type ProductDetailsT = {
  productName: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
};

const calculateShares = (
  totalCost: number,
  patientInsurance: PatientInsurance | null
) => {
  if (!patientInsurance) {
    return { patientShare: totalCost, insuranceShare: 0 };
  }
  const coveragePercentage = patientInsurance.coveragePercentage;
  const insuranceShare = totalCost * (Number(coveragePercentage) / 100);
  const patientShare = totalCost - insuranceShare;
  return { patientShare, insuranceShare };
};

export const hospitalizePatient = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedJson = c.get("validatedJson");
    if (!validatedJson) {
      return c.json(
        { error: "Invalid data" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { visitId, roomId, isRoomCoveredByInsurance } = validatedJson;
    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        clinicId: true,
        branchId: true,
        paymentMode: true,
        patient: true,
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const room = await db.room.findUnique({
      where: { id: roomId },
      select: {
        class: true,
        isOccupied: true,
        number: true,
        clinic: {
          select: {
            roomPrices: true,
          },
        },
      },
    });
    if (!room) {
      return c.json(
        { error: "Room not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (room.isOccupied) {
      return c.json(
        { error: "Room is already occupied" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const roomPrice = room.clinic.roomPrices.find(
      (price) => price.class === room.class
    );
    if (!roomPrice) {
      return c.json(
        { error: "Room price not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const hospitalization = await db.$transaction(async (tx) => {
      const newHospitalization = await tx.hospitalization.create({
        data: {
          visitId,
          roomId,
          roomCoveredByInsurance: isRoomCoveredByInsurance,
          patientId: visit.patient.id,
          clinicId: visit.clinicId,
          branchId: visit.branchId,
        },
      });
      await tx.payment.create({
        data: {
          visitId,
          clinicId: visit.clinicId,
          amount: 0,
          patientAmount: 0,
          insuranceAmount: 0,
          paymentType: PaymentType.HOSPITALIZATION,
          paymentMode: visit.paymentMode as PaymentMode,
        },
      });
      await tx.room.update({
        where: { id: roomId },
        data: {
          isOccupied: true,
        },
      });
      await tx.visit.update({
        where: { id: visitId },
        data: {
          status: VisitStatus.ADMITTED,
        },
      });
      return newHospitalization;
    });
    await logActivity({
      userId: user.id,
      visitId,
      action: `Patient ${visit.patient.firstName} ${visit.patient.lastName} hospitalized in room ${room.number}`,
      type: ActivityType.HOSPITALIZATION,
    });
    return c.json(
      { success: "Patient hospitalized successfully", data: hospitalization },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addHospitalizationProducts = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedJson = c.get("validatedJson") as z.infer<
      typeof addProductSchema
    >;
    if (!(validatedJson && addProductSchema.safeParse(validatedJson).success)) {
      return c.json(
        { error: "Invalid data" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { visitId, products } = validatedJson;

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        hospitalization: true,
        patientInsurance: true,
        paymentMode: true,
        payments: {
          where: {
            paymentType: PaymentType.HOSPITALIZATION,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!visit?.hospitalization || visit.payments.length === 0) {
      return c.json(
        {
          error:
            "Visit not found, patient not hospitalized, or payment record missing!",
        },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const payment = visit.payments[0];
    const result = await db.$transaction(async (tx) => {
      let totalCost = 0;
      let totalPatientAmount = 0;
      let totalInsuranceAmount = 0;
      const paymentDetails: ProductDetailsT[] = [];
      const addedProducts = await Promise.all(
        products.map(async (product) => {
          const dbProduct = await db.product.findUnique({
            where: { id: product.productId },
            select: {
              name: true,
              insurancePrices: true,
              basePrice: true,
            },
          });
          if (!dbProduct) {
            throw new Error(`Product with id ${product.productId} not found`);
          }
          if (visit.paymentMode === PaymentMode.INSURANCE) {
            const insurancePrice = dbProduct.insurancePrices.find(
              (pr) =>
                pr.insuranceCompanyId ===
                visit.patientInsurance?.insuranceCompanyId
            );
            if (!insurancePrice) {
              throw new Error(
                `Insurance price not defined for product: ${dbProduct.name}`
              );
            }
            const price = insurancePrice.price;
            const { patientShare, insuranceShare } = calculateShares(
              Number(price) * product.quantity,
              visit.patientInsurance
            );
            totalCost += Number(price) * product.quantity;
            totalPatientAmount += patientShare;
            totalInsuranceAmount += insuranceShare;
            paymentDetails.push({
              productName: dbProduct.name,
              amount: Number(price) * product.quantity,
              patientAmount: patientShare,
              insuranceAmount: insuranceShare,
            });
          } else {
            if (!dbProduct.basePrice) {
              throw new Error(
                `Base price not defined for product: ${dbProduct.name}`
              );
            }
            totalCost += Number(dbProduct.basePrice) * product.quantity;
            totalPatientAmount +=
              Number(dbProduct.basePrice) * product.quantity;
            paymentDetails.push({
              productName: dbProduct.name,
              amount: Number(dbProduct.basePrice) * product.quantity,
              patientAmount: Number(dbProduct.basePrice) * product.quantity,
              insuranceAmount: 0,
            });
          }
          const hospitalizationProduct = await tx.hospitalizationProduct.create(
            {
              data: {
                visitId,
                productId: product.productId,
                quantity: product.quantity,
              },
            }
          );
          return hospitalizationProduct;
        })
      );
      const existingPaymentDetails =
        (payment.paymentDetails as ProductDetailsT[]) || [];
      const updatedPaymentDetails = [
        ...existingPaymentDetails,
        ...paymentDetails,
      ];
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          amount: { increment: totalCost },
          patientAmount: { increment: totalPatientAmount },
          insuranceAmount: { increment: totalInsuranceAmount },
          paymentDetails: updatedPaymentDetails,
        },
      });
      return addedProducts;
    });
    await logActivity({
      userId: user.id,
      visitId,
      action: `Added ${products.length} products to hospitalization`,
      type: ActivityType.BILL_UPDATE,
    });
    return c.json(
      {
        success: "Products added to hospitalization successfully",
        data: result,
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const dischargePatient = async (c: Context) => {
  try {
    const user = c.get("user");
    const visitIdRaw = c.req.param("visitId");
    const visitId = Number.parseInt(visitIdRaw, 10);

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        clinicId: true,
        hospitalization: {
          select: {
            id: true,
            admittedAt: true,
            room: true,
            roomCoveredByInsurance: true,
          },
        },
        patientInsurance: true,
        payments: {
          where: { paymentType: PaymentType.HOSPITALIZATION },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        patient: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!visit?.hospitalization || visit.payments.length === 0) {
      return c.json(
        {
          error:
            "Visit not found, patient not hospitalized, or payment record missing!",
        },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const payment = visit.payments[0];
    const roomPrice = await db.roomPrice.findUnique({
      where: {
        clinicId_class: {
          clinicId: visit.clinicId,
          class: visit.hospitalization.room.class,
        },
      },
    });
    if (!roomPrice) {
      return c.json(
        {
          error: "Room price not found",
        },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const daysHospitalized = differenceInDays(
      new Date(),
      visit.hospitalization.admittedAt
    );
    const totalRoomCost = Number(roomPrice.price) * daysHospitalized;
    const {
      patientShare: patientRoomShare,
      insuranceShare: insuranceRoomShare,
    } = visit.hospitalization.roomCoveredByInsurance
      ? calculateShares(totalRoomCost, visit.patientInsurance)
      : { patientShare: totalRoomCost, insuranceShare: 0 };
    const totalBill = Number(payment.amount) + totalRoomCost;
    const totalPatientAmount = Number(payment.patientAmount) + patientRoomShare;
    const totalInsuranceAmount =
      Number(payment.insuranceAmount) + insuranceRoomShare;
    const updatedPaymentDetails = [
      ...(payment.paymentDetails as ProductDetailsT[]),
      {
        productName: "Hospital Room",
        amount: totalRoomCost,
        patientAmount: patientRoomShare,
        insuranceAmount: insuranceRoomShare,
      },
    ];

    await db.$transaction(async (tx) => {
      await tx.hospitalization.update({
        where: { id: visit.hospitalization?.id },
        data: { dischargedAt: new Date() },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          amount: totalBill,
          patientAmount: totalPatientAmount,
          insuranceAmount: totalInsuranceAmount,
          paymentDetails: updatedPaymentDetails,
        },
      });
      await tx.visit.update({
        where: { id: visitId },
        data: { status: VisitStatus.DISCHARGED },
      });
      await tx.room.update({
        where: { id: visit.hospitalization?.room.id },
        data: { isOccupied: false },
      });
    });

    await logActivity({
      userId: user.id,
      visitId,
      action: `Patient ${visit.patient.firstName} ${visit.patient.lastName} discharged from hospital`,
      type: ActivityType.HOSPITALIZATION,
    });
    return c.json(
      { success: "Patient discharged successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getHospitalizations = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Hospitalization>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const hospitalizations = await db.hospitalization.findMany({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.HospitalizationWhereInput,
      orderBy: orderBy as Prisma.HospitalizationOrderByWithRelationInput,
      ...restOptions,
      select: {
        id: true,
        visit: {
          select: {
            id: true,
            status: true,
            payments: {
              where: {
                paymentType: PaymentType.HOSPITALIZATION,
              },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                id: true,
                amount: true,
                patientAmount: true,
                insuranceAmount: true,
                paymentDetails: true,
                paymentMode: true,
                paymentStatus: true,
                updatedAt: true,
              },
            },
          },
        },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
          },
        },
        room: {
          select: {
            id: true,
            number: true,
            class: true,
          },
        },
        admittedAt: true,
        dischargedAt: true,
        updatedAt: true,
        createdAt: true,
        roomCoveredByInsurance: true,
      },
    });
    const totalCount = await db.hospitalization.count({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.HospitalizationWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      { data: hospitalizations, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getHospitalizationRooms = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Room>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const rooms = await db.room.findMany({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.RoomWhereInput,
      orderBy: orderBy as Prisma.RoomOrderByWithRelationInput,
      ...restOptions,
      select: {
        id: true,
        number: true,
        class: true,
        isOccupied: true,
        createdAt: true,
        updatedAt: true,
        clinic: {
          select: {
            name: true,
            roomPrices: true,
          },
        },
      },
    });

    const roomsWithPrices = rooms.map((room) => ({
      ...room,
      price: room.clinic.roomPrices.find((price) => price.class === room.class)
        ?.price,
    }));

    const totalCount = await db.room.count({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.RoomWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      { data: roomsWithPrices, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getHospitalizationRoomPrices = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<RoomPrice>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const roomPrices = await db.roomPrice.findMany({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.RoomPriceWhereInput,

      orderBy: orderBy as Prisma.RoomPriceOrderByWithRelationInput,
      ...restOptions,
    });
    const totalCount = await db.roomPrice.count({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      } as Prisma.RoomPriceWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      { data: roomPrices, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addHospitalizationRoom = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedJson = c.get("validatedJson");
    if (!validatedJson) {
      return c.json(
        { error: "Invalid data" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { number, class: roomClass } = validatedJson;
    const room = await db.room.create({
      data: {
        number,
        class: roomClass,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      },
    });
    return c.json(
      { success: "Room added successfully", data: room },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const setHospitalizationRoomPrice = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedJson = c.get("validatedJson");
    if (!validatedJson) {
      return c.json(
        { error: "Invalid data" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { class: roomClass, price } = validatedJson;
    const roomPrice = await db.roomPrice.upsert({
      where: {
        clinicId_class: {
          clinicId: user.clinic.id,
          class: roomClass,
        },
      },
      update: {
        price,
      },
      create: {
        class: roomClass,
        price,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      },
    });
    return c.json(
      { success: "Room price added successfully", data: roomPrice },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getRoomsByClass = async (c: Context) => {
  try {
    const user = c.get("user");
    const roomClass = c.req.query("roomClass");
    const rooms = await db.room.findMany({
      where: {
        clinicId: user.clinic.id,
        branchId: user.branch.id,
        class: roomClass as RoomClass,
      },
    });
    return c.json({ data: rooms }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
