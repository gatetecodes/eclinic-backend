import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "@/database/db";
import type { User } from "@/lib/auth";
import { httpCodes } from "@/lib/constants";
import { parseDateString } from "@/lib/utils";

export const initMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT") {
    return c.json(
      { error: "Forbidden" },
      httpCodes.FORBIDDEN as ContentfulStatusCode
    );
  }
  if (user.patientId) {
    return c.json(
      { error: "Already initialized" },
      httpCodes.BAD_REQUEST as ContentfulStatusCode
    );
  }
  const body = c.get("validatedJson");
  const result = await db.$transaction(async (tx) => {
    const patient = await tx.patient.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: parseDateString(body.dateOfBirth),
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
  return c.json(
    { status: httpCodes.OK, data: result },
    httpCodes.OK as ContentfulStatusCode
  );
};

export const linkMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT") {
    return c.json(
      { error: "Forbidden" },
      httpCodes.FORBIDDEN as ContentfulStatusCode
    );
  }
  const body = c.get("validatedJson");
  const patient = await db.patient.findUnique({
    where: { id: body.patientId },
  });
  if (!patient) {
    return c.json(
      { error: "Patient not found" },
      httpCodes.NOT_FOUND as ContentfulStatusCode
    );
  }
  if (
    patient.phoneNumber !== body.phoneNumber &&
    patient.guardianPhoneNumber !== body.phoneNumber
  ) {
    return c.json(
      { error: "Phone number mismatch" },
      httpCodes.BAD_REQUEST as ContentfulStatusCode
    );
  }
  await db.user.update({
    where: { id: Number(user.id) },
    data: { patientId: patient.id },
  });
  return c.json(
    { status: httpCodes.OK, data: { patientId: patient.id } },
    httpCodes.OK as ContentfulStatusCode
  );
};

export const getMe = async (c: Context) => {
  const user = c.get("user") as User;
  if (user?.role !== "PATIENT" || !user.patientId) {
    return c.json(
      { error: "Not initialized" },
      httpCodes.BAD_REQUEST as ContentfulStatusCode
    );
  }
  const patient = await db.patient.findUnique({
    where: { id: Number(user.patientId) },
  });
  return c.json(
    { status: httpCodes.OK, data: patient },
    httpCodes.OK as ContentfulStatusCode
  );
};
