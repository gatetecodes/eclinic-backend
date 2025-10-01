import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import {
  addHours,
  addMinutes,
  endOfDay,
  format,
  getDay,
  isBefore,
  parse,
  startOfDay,
  subDays,
} from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants.ts";
import {
  type EducationLevel,
  type Prisma,
  Role,
  type User,
  UserStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { logger } from "../../../lib/logger";
import { sendEmail } from "../../../services/email.service";
// token helpers defined below
import {
  createDoctorSchema,
  createUserSchema,
  editDoctorSchema,
  updateUserSchema,
} from "./users.validation";

const EMAIL_RETRY_DELAY_MS = 1000;

const sendVerificationEmailSafe = async (
  email: string,
  token: string
): Promise<{ success: boolean; error?: unknown }> => {
  try {
    const context = getVerificationTemplateContext(token);
    await sendEmail({
      to: email,
      subject: "Verify your account",
      template: "verification",
      context,
    });
    return { success: true };
  } catch (error) {
    logger.error("Failed to send verification email", { email, error });
    return { success: false, error };
  }
};

const sendVerificationEmailWithRetry = async (
  email: string,
  token: string,
  maxRetries = 3
): Promise<{ success: boolean; error?: unknown }> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await sendVerificationEmailSafe(email, token);
    if (result.success) {
      return result;
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, EMAIL_RETRY_DELAY_MS));
    }
  }
  return {
    success: false,
    error: new Error("Failed to send verification email after retries"),
  };
};

type AuthenticatedUser = {
  id: number;
  role: Role;
  clinic: { id: number };
  branch: { id: number };
};

const generateVerificationToken = async (email: string) => {
  await db.verificationToken.deleteMany({ where: { email } });
  return db.verificationToken.create({
    data: {
      email,
      token: randomUUID(),
      expires: addHours(new Date(), 1),
    },
  });
};

const getVerificationTemplateContext = (token: string) => {
  const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL;
  if (!appUrl) {
    throw new Error("APP_URL is not configured");
  }
  return {
    verificationLink: `${appUrl}/auth/new-verification?token=${token}`,
  } as const;
};

export const createVerificationEmail = async (email: string) => {
  const token = await generateVerificationToken(email);
  return sendVerificationEmailWithRetry(email, token.token);
};

const formatLicenseExpiration = (value?: string | null) =>
  value ? new Date(value) : null;

const filterValidAvailability = (
  weeklyAvailability?: Array<{
    startDayOfWeek: number;
    endDayOfWeek: number;
    startTime: string;
    endTime: string;
  }> | null
) =>
  weeklyAvailability?.filter(
    (slot) => slot.startTime !== "" && slot.endTime !== ""
  ) ?? [];

export const getClinicUsers = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<User>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const listWhere: Prisma.UserWhereInput = {
      ...(where as Prisma.UserWhereInput),
      clinicId: authUser.clinic.id,
      role: {
        notIn: ["DOCTOR", "NURSE"],
      },
    };

    const users = await db.user.findMany({
      ...restOptions,
      where: listWhere,
      orderBy: orderBy as Prisma.UserOrderByWithRelationInput,
      include: {
        clinicalDepartments: {
          select: { id: true, name: true },
        },
        branch: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            doctorEvents: true,
            doctorVisits: true,
          },
        },
      },
    });

    const totalCount = await db.user.count({ where: listWhere });
    const take = restOptions.take ?? 0;
    const pageCount = take > 0 ? Math.ceil(totalCount / take) : 0;

    return c.json(
      { data: users, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to list clinic users", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addNewUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const body = await c.get("validatedJson");
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { name, email, role, phone_number, password } = parsed.data;

    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return c.json(
        { error: "User with this email already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    const hashedPassword = await hash(password, 10);

    await db.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role as Role,
        emailVerified: new Date(),
        phone_number,
        clinicId: authUser.clinic.id,
        branchId: authUser.branch.id,
      },
    });

    const emailResult = await createVerificationEmail(email);
    if (!emailResult.success) {
      logger.warn("User created but verification email failed", {
        email,
        error: emailResult.error,
      });
      return c.json(
        {
          success: "User created successfully, verification email pending",
        },
        httpCodes.CREATED as ContentfulStatusCode
      );
    }

    return c.json(
      { success: "User created successfully" },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to create user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorsByDepartmentId = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const departmentIdRaw = c.req.param("departmentId");
    const departmentId = Number.parseInt(departmentIdRaw, 10);
    if (!Number.isFinite(departmentId) || departmentId <= 0) {
      return c.json(
        { error: "Invalid departmentId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const clinic = await db.clinic.findUnique({
      where: { id: authUser.clinic.id },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: clinic.id,
        clinicalDepartments: {
          some: { id: departmentId },
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch doctors by department", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const userIdRaw = c.req.param("userId");
    const userId = Number.parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { email, name, role, phone_number, password } = parsed.data;

    const existingUser = await db.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (existingUser.clinicId !== authUser.clinic.id) {
      return c.json(
        { error: "You are not authorized to edit this user" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updateData: Prisma.UserUpdateInput = {
      name,
      email,
      role: role as Role,
      phone_number,
    };

    if (password) {
      updateData.password = await hash(password, 10);
    }

    await db.user.update({
      where: { id: userId },
      data: updateData,
    });

    return c.json(
      { success: "User updated successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to update user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deactivateUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const userIdRaw = c.req.param("userId");
    const userId = Number.parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const targetUser = await db.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (targetUser.clinicId !== authUser.clinic.id) {
      return c.json(
        { error: "You are not authorized to perform this action" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    await db.user.update({
      where: { id: userId },
      data: { status: UserStatus.INACTIVE },
    });

    return c.json(
      { success: "User deactivated successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to deactivate user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN" && authUser.role !== "DOCTOR") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<User>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const doctorWhere: Prisma.UserWhereInput = {
      ...(where as Prisma.UserWhereInput),
      clinicId: authUser.clinic.id,
      role: {
        in: [Role.DOCTOR, Role.NURSE],
      },
    };

    const doctors = await db.user.findMany({
      ...restOptions,
      where: doctorWhere,
      orderBy: orderBy as Prisma.UserOrderByWithRelationInput,
      include: {
        clinicalDepartments: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            doctorEvents: true,
            doctorVisits: true,
          },
        },
        doctorAvailabilities: {
          select: {
            id: true,
            dayOfWeek: true,
            startDayOfWeek: true,
            endDayOfWeek: true,
            startTime: true,
            endTime: true,
          },
        },
      },
    });

    const totalCount = await db.user.count({ where: doctorWhere });
    const take = restOptions.take ?? 0;
    const pageCount = take > 0 ? Math.ceil(totalCount / take) : 0;

    return c.json(
      { data: doctors, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to list clinic doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const body = await c.get("validatedJson");
    const parsed = createDoctorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { weeklyAvailability, departments, ...doctorData } = parsed.data;

    const existing = await db.user.findUnique({
      where: { email: doctorData.email },
    });

    if (existing) {
      return c.json(
        { error: "User with this email already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    const hashedPassword = await hash(doctorData.password, 10);

    const newDoctor = await db.$transaction(async (tx) => {
      const doctor = await tx.user.create({
        data: {
          name: doctorData.name,
          email: doctorData.email,
          phone_number: doctorData.phone_number,
          role: doctorData.role as Role,
          password: hashedPassword,
          clinicId: authUser.clinic.id,
          branchId: authUser.branch.id,
          emailVerified: new Date(),
          consultationFee: doctorData.consultationFee,
          licenseNumber: doctorData.licenseNumber,
          licenseExpiration: formatLicenseExpiration(
            doctorData.licenseExpiration
          ),
          license_document: doctorData.license_document,
          diploma_document: doctorData.diploma_document,
          highestEducation: doctorData.highestEducation as
            | EducationLevel
            | undefined,
          clinicalDepartments: {
            connect: departments.map((departmentId) => ({ id: departmentId })),
          },
        },
      });

      const availabilityData = filterValidAvailability(weeklyAvailability).map(
        (slot) => ({
          doctorId: doctor.id,
          startDayOfWeek: slot.startDayOfWeek,
          startTime: slot.startTime,
          endDayOfWeek: slot.endDayOfWeek,
          endTime: slot.endTime,
        })
      );

      if (availabilityData.length > 0) {
        await tx.doctorAvailability.createMany({ data: availabilityData });
      }

      return doctor;
    });

    const emailResult = await createVerificationEmail(doctorData.email);
    if (!emailResult.success) {
      logger.warn("Doctor created but verification email failed", {
        email: doctorData.email,
        error: emailResult.error,
      });
      return c.json(
        {
          success: "Doctor created successfully",
          message: "Verification email will be retried",
          doctor: {
            id: newDoctor.id,
            name: newDoctor.name,
            email: newDoctor.email,
          },
        },
        httpCodes.CREATED as ContentfulStatusCode
      );
    }

    return c.json(
      {
        success: "Doctor created successfully",
        doctor: {
          id: newDoctor.id,
          name: newDoctor.name,
          email: newDoctor.email,
        },
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to create doctor", { error });
    return c.json(
      { error: "Failed to create doctor" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addDoctorAvailability = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const valid = filterValidAvailability(body.weeklyAvailability).map(
      (slot) => ({
        doctorId: authUser.id,
        startDayOfWeek: slot.startDayOfWeek,
        startTime: slot.startTime,
        endDayOfWeek: slot.endDayOfWeek,
        endTime: slot.endTime,
      })
    );
    if (valid.length === 0) {
      return c.json(
        { error: "Invalid weekly availability" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    await db.doctorAvailability.createMany({ data: valid });
    return c.json(
      { success: "Doctor availability added successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to add doctor availability", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const assignDepartmentsToDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const validDepartments = await db.clinicalDepartment.findMany({
      where: { id: { in: body.departments } },
      select: { id: true },
    });
    if (validDepartments.length !== body.departments.length) {
      return c.json(
        { error: "Invalid departments" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    await db.user.update({
      where: { id: authUser.id },
      data: {
        clinicalDepartments: {
          connect: validDepartments.map((department) => ({
            id: department.id,
          })),
        },
      },
    });
    return c.json(
      { success: "Departments assigned to doctor successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to assign departments to doctor", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAllClinicDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: authUser.clinic.id,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch clinic doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAllBranchDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        branchId: authUser.branch.id,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch branch doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const doctorIdRaw = c.req.param("doctorId");
    const doctorId = Number.parseInt(doctorIdRaw, 10);
    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return c.json(
        { error: "Invalid doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const parsed = editDoctorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { weeklyAvailability, departments, password, ...doctorData } =
      parsed.data;

    const existingDoctor = await db.user.findUnique({
      where: { id: doctorId },
    });
    if (!existingDoctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (existingDoctor.clinicId !== authUser.clinic.id) {
      return c.json(
        { error: "You are not authorized to edit this doctor" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const availabilityData = filterValidAvailability(weeklyAvailability).map(
      (slot) => ({
        startDayOfWeek: slot.startDayOfWeek,
        startTime: slot.startTime,
        endDayOfWeek: slot.endDayOfWeek,
        endTime: slot.endTime,
      })
    );

    const updateData: Prisma.UserUpdateInput = {
      name: doctorData.name,
      email: doctorData.email,
      role: doctorData.role as Role,
      phone_number: doctorData.phone_number,
      consultationFee: doctorData.consultationFee,
      licenseNumber: doctorData.licenseNumber,
      licenseExpiration: formatLicenseExpiration(doctorData.licenseExpiration),
      license_document: doctorData.license_document,
      diploma_document: doctorData.diploma_document,
      highestEducation: doctorData.highestEducation as
        | EducationLevel
        | undefined,
      clinicalDepartments: {
        set: departments?.map((departmentId) => ({ id: departmentId })),
      },
      doctorAvailabilities: {
        deleteMany: {},
        createMany: {
          data: availabilityData,
        },
      },
    };

    if (password) {
      updateData.password = await hash(password, 10);
    }

    await db.user.update({
      where: { id: doctorId },
      data: updateData,
    });

    return c.json(
      {
        success: "Doctor updated successfully",
        doctor: { id: existingDoctor.id, email: existingDoctor.email },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to update doctor", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getCashiers = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const cashiers = await db.user.findMany({
      where: {
        role: Role.CASHIER,
        clinicId: authUser.clinic.id,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: cashiers }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch cashiers", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableDoctorsByDepartmentId = async (c: Context) => {
  try {
    const user = c.get("user") as AuthenticatedUser | undefined;
    if (!user) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const { departmentId, date, includeDoctorId } = c.get("validatedJson");
    const clinic = await db.clinic.findUnique({
      where: { id: +user?.clinic.id },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Fetch doctors in department with their schedules
    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: clinic.id,
        clinicalDepartments: { some: { id: departmentId } },
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        doctorAvailabilities: {
          select: {
            id: true,
            startDayOfWeek: true,
            endDayOfWeek: true,
            startTime: true,
            endTime: true,
          },
        },
      },
    });

    if (doctors.length === 0) {
      return c.json({ data: [] }, httpCodes.OK as ContentfulStatusCode);
    }

    const targetDay = getDay(date);
    const prevDay = getDay(subDays(date, 1));

    const startOfTargetDay = startOfDay(date);
    const endOfTargetDay = endOfDay(date);

    // For each doctor, load booked appointment start times for the day
    const doctorIds = doctors.map((d) => d.id);
    const eventsByDoctor: Record<number, Set<string>> = {};
    for (const doctorId of doctorIds) {
      const existingAppointments = await db.event.findMany({
        where: {
          doctorId,
          startTime: {
            gte: startOfTargetDay,
            lte: endOfTargetDay,
          },
          type: "APPOINTMENT",
          status: { not: "CANCELLED" },
        },
        select: { startTime: true },
      });
      eventsByDoctor[doctorId] = new Set(
        existingAppointments.map((appointment) =>
          format(appointment.startTime, "HH:mm")
        )
      );
    }

    const availableDoctors: { id: number; name: string }[] = [];

    for (const doc of doctors) {
      const potentialSchedules = doc.doctorAvailabilities.filter(
        (s) => s.startDayOfWeek === targetDay || s.startDayOfWeek === prevDay
      );

      if (potentialSchedules.length === 0) {
        continue; // No schedule for today
      }

      const bookedTimes = eventsByDoctor[doc.id] ?? new Set<string>();
      const hasAnyAvailable = potentialSchedules.some((schedule) => {
        if (
          schedule.startDayOfWeek === null ||
          schedule.endDayOfWeek === null ||
          schedule.startTime === null ||
          schedule.endTime === null
        ) {
          return false;
        }

        const startOffset =
          (targetDay - (schedule.startDayOfWeek as number) + 7) % 7; // Wrap around to Sunday (0)
        const endOffset =
          (targetDay - (schedule.endDayOfWeek as number) + 7) % 7; // Wrap around to Sunday (0)
        const scheduleStartDate = subDays(date, startOffset);
        const scheduleEndDate = subDays(date, endOffset);

        const startTime = parse(
          schedule.startTime as string,
          "HH:mm",
          scheduleStartDate
        );
        let endTime = parse(
          schedule.endTime as string,
          "HH:mm",
          scheduleEndDate
        );

        if (isBefore(endTime, startTime)) {
          // Overnight schedule wraps to next day
          endTime = addMinutes(endTime, 24 * 60);
        }

        const effectiveStartTime = new Date(
          Math.max(startTime.getTime(), startOfTargetDay.getTime())
        );
        const effectiveEndTime = new Date(
          Math.min(endTime.getTime(), endOfTargetDay.getTime())
        );

        // Scan hour slots for any free slot today
        let currentTime = new Date(effectiveStartTime);
        // Align to hour
        currentTime.setMinutes(0, 0, 0);
        while (isBefore(currentTime, effectiveEndTime)) {
          const timeSlot = format(currentTime, "HH:mm");
          if (!bookedTimes.has(timeSlot)) {
            return true;
          }
          currentTime = addMinutes(currentTime, 60);
        }

        return false;
      });

      if (hasAnyAvailable) {
        availableDoctors.push({ id: doc.id, name: doc.name });
      }
    }

    // Ensure included doctor is present (for edit screens)
    if (
      includeDoctorId &&
      !availableDoctors.some((d) => d.id === includeDoctorId)
    ) {
      const extra = await db.user.findFirst({
        where: {
          id: includeDoctorId,
          clinicId: clinic.id,
          role: Role.DOCTOR,
        },
        select: { id: true, name: true },
      });
      if (extra) {
        availableDoctors.push(extra);
      }
    }

    return c.json(
      { data: availableDoctors },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to fetch available doctors by department", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
