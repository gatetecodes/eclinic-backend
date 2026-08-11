import type { Context } from "hono";
import { db } from "@/database/db";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { AppError } from "@/lib/app-error";
import type { User } from "@/lib/auth";
import { httpCodes } from "@/lib/constants";
import { parseDateString } from "@/lib/utils";

export const initMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT") {
    return jsonError(c, {
      status: httpCodes.FORBIDDEN,
      code: "FORBIDDEN",
      message: "Forbidden",
    });
  }
  if (user.patientId) {
    return jsonError(c, {
      status: httpCodes.BAD_REQUEST,
      code: "ALREADY_INITIALIZED",
      message: "Already initialized",
    });
  }
  const body = c.get("validatedJson");
  let dateOfBirth: Date;
  try {
    dateOfBirth = parseDateString(body.dateOfBirth);
  } catch {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INVALID_DATE_OF_BIRTH",
      message: "Invalid date of birth",
      exposeMessage: true,
    });
  }
  const result = await db.$transaction(async (tx) => {
    const patient = await tx.patient.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth,
        gender: body.gender,
        phoneNumber: body.phoneNumber,
        email: body.email ?? null,
      },
    });
    await tx.user.update({
      where: { id: Number(user.id) },
      data: { patientId: patient.id, phone_number: body.phoneNumber },
    });
    return patient;
  });
  return jsonSuccess(c, { status: httpCodes.OK, data: result });
};

export const linkMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT") {
    return jsonError(c, {
      status: httpCodes.FORBIDDEN,
      code: "FORBIDDEN",
      message: "Forbidden",
    });
  }
  const body = c.get("validatedJson");
  const patient = await db.patient.findUnique({
    where: { id: body.patientId },
  });
  if (!patient) {
    return jsonError(c, {
      status: httpCodes.NOT_FOUND,
      code: "PATIENT_NOT_FOUND",
      message: "Patient not found",
    });
  }
  if (
    patient.phoneNumber !== body.phoneNumber &&
    patient.guardianPhoneNumber !== body.phoneNumber
  ) {
    return jsonError(c, {
      status: httpCodes.BAD_REQUEST,
      code: "PHONE_NUMBER_MISMATCH",
      message: "Phone number mismatch",
    });
  }
  await db.user.update({
    where: { id: Number(user.id) },
    data: { patientId: patient.id },
  });
  return jsonSuccess(c, {
    status: httpCodes.OK,
    data: { patientId: patient.id },
  });
};

export const getMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT" || !user.patientId) {
    return jsonError(c, {
      status: httpCodes.BAD_REQUEST,
      code: "NOT_INITIALIZED",
      message: "Not initialized",
    });
  }
  const patient = await db.patient.findUnique({
    where: { id: Number(user.patientId) },
  });
  return jsonSuccess(c, { status: httpCodes.OK, data: patient });
};
