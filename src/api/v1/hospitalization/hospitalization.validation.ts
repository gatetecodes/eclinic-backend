import z from "zod";
import { RoomClass } from "../../../../generated/prisma";

export const addProductSchema = z.object({
  visitId: z.coerce.number(),
  products: z.array(
    z.object({
      productId: z.coerce.number(),
      quantity: z.number().min(1),
      basePrice: z.number().optional(),
    })
  ),
});

export const hospitalizeSchema = z.object({
  visitId: z.coerce.number(),
  roomId: z.coerce.number(),
  isRoomCoveredByInsurance: z.boolean(),
});

export const roomSchema = z.object({
  number: z.string(),
  class: z.nativeEnum(RoomClass),
});

export const roomPriceSchema = z.object({
  class: z.nativeEnum(RoomClass),
  price: z.coerce.number().positive(),
});
