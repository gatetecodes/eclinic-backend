import {
  type CurrencyCode,
  Role,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import { defaultFlowConfigRows } from "../lib/clinic-flow";
import { createStaffAccount } from "./staff-account.service";

export type ProvisionClinicInput = {
  name: string;
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus?: SubscriptionStatus;
  operatingCountry?: string;
  defaultCurrency?: CurrencyCode;
  logo?: string | null;
  subscriptionExpiryDate?: Date | string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  admin: { name: string; email: string; phone_number: string };
};

/**
 * Create a new tenant in one transaction: Clinic + "Main Branch" + default
 * care-flow config + a CLINIC_ADMIN user with a better-auth credential account.
 * Mirrors the createClinic flow; used by demo→trial provisioning so the two
 * paths stay consistent. The caller is responsible for the verification email.
 */
export function provisionClinic(input: ProvisionClinicInput) {
  return db.$transaction(async (tx) => {
    const newClinic = await tx.clinic.create({
      data: {
        name: input.name,
        subscriptionPlan: input.subscriptionPlan,
        ...(input.subscriptionStatus
          ? { subscriptionStatus: input.subscriptionStatus }
          : {}),
        operatingCountry: (input.operatingCountry ?? "RW").toUpperCase(),
        defaultCurrency: input.defaultCurrency,
        logo: input.logo,
        subscriptionExpiryDate: input.subscriptionExpiryDate,
        contactEmail: input.contactEmail ?? undefined,
        contactPhone: input.contactPhone ?? undefined,
      },
    });

    const branch = await tx.branch.create({
      data: {
        name: "Main Branch",
        code: "MAIN",
        clinicId: newClinic.id,
        isHeadOffice: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await tx.clinicFlowConfig.createMany({
      data: defaultFlowConfigRows(newClinic.id),
    });

    const adminUser = await createStaffAccount(tx, {
      name: input.admin.name,
      email: input.admin.email,
      phone_number: input.admin.phone_number,
      branchId: branch.id,
      clinicId: newClinic.id,
      role: Role.CLINIC_ADMIN,
    });

    return { newClinic, branch, adminUser };
  });
}
