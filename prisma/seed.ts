//biome-ignore-all lint/suspicious/noConsole: <>
import { randomBytes, scryptSync } from "node:crypto";
import {
  PrismaClient,
  Role,
  SubscriptionPlan,
  SubscriptionStatus,
  UserStatus,
} from "../generated/prisma";

const InsuranceCompanies = {
  SONARWA: "SONARWA",
  SANLAM: "SANLAM",
  PRIME: "PRIME",
  MUA: "MUA",
  OLD_MUTUAL: "OLD MUTUAL",
  RADIANT: "RADIANT",
  BRITAM: "BRITAM",
  BK_INSURANCE: "BK INSURANCE",
  MAYFAIR: "MAYFAIR",
  DEFENCE_CAPTIVE: "DEFENCE CAPTIVE",
  EDEN_CARE: "EDEN CARE",
  CIMERWA: "CIMERWA",
  SINALAC: "SINALAC",
  UBUZIMA_BWIZA: "UBUZIMA BWIZA",
};

const SpecialInsurers = {
  RSSB: "RSSB",
  MMI: "MMI",
  MIS_UR: "MIS_UR",
};

const SALT_LENGTH = 16;
const DERIVED_KEY_LENGTH = 64;
const N = 16_384;
const r = 16;
const p = 1;
const SCRYPT_MAXMEM_BASE = 128;
const SCRYPT_MAXMEM_FACTOR = 2;
const maxmem = SCRYPT_MAXMEM_BASE * N * r * SCRYPT_MAXMEM_FACTOR;

const db = new PrismaClient();

// Better Auth-compatible scrypt password hash: `${saltHex}:${keyHex}`
function hashCredentialPassword(password: string): string {
  const dkLen = DERIVED_KEY_LENGTH;
  const saltHex = randomBytes(SALT_LENGTH).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), saltHex, dkLen, {
    N,
    r,
    p,
    maxmem,
  });
  return `${saltHex}:${key.toString("hex")}`;
}

const clinicSeed = async () => {
  try {
    // Create clinic first
    const clinic = await db.clinic.upsert({
      where: {
        id: 1,
      },
      update: {},
      create: {
        name: "Oana Clinic",
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        subscriptionPlan: SubscriptionPlan.HOSPITAL_SUITE,
      },
    });

    console.log("Clinic created successfully:", clinic);

    // Create branch
    const branch = await db.branch.upsert({
      where: {
        id: 1,
      },
      update: {},
      create: {
        name: "Main Branch",
        code: "MAIN",
        address: "Kigali, Rwanda",
        contactPhone: "+250788500000",
        contactEmail: "info@oana.com",
        isHeadOffice: true,
        clinic: {
          connect: {
            id: clinic.id,
          },
        },
      },
    });

    console.log("Branch created successfully:", branch);

    // Create clinic admin
    const oanaPlain = process.env.OANA_ADMIN_PASSWORD as string;
    // Better Auth credential hash (scrypt salt:key)
    const oanaCredentialHash = await hashCredentialPassword(oanaPlain);

    const user = await db.user.upsert({
      where: {
        email: process.env.OANA_ADMIN_EMAIL as string,
      },
      update: {},
      create: {
        name: `${process.env.OANA_ADMIN_FIRST_NAME} ${process.env.OANA_ADMIN_LAST_NAME}`,
        email: process.env.OANA_ADMIN_EMAIL as string,
        role: Role.CLINIC_ADMIN,
        status: UserStatus.ACTIVE,
        phone_number: process.env.OANA_ADMIN_PHONE_NUMBER as string,
        emailVerified: new Date(),
        phone_number_verified: new Date(),
        clinic: {
          connect: {
            id: clinic.id,
          },
        },
        branch: {
          connect: {
            id: branch.id,
          },
        },
      },
    });

    console.log("Clinic admin created successfully:", user);

    // Ensure credential account for email/password auth
    const existingClinicAdminAccount = await db.account.findFirst({
      where: {
        userId: user.id,
        accountId: user.email,
        providerId: { in: ["email", "email-password", "credential"] },
      },
    });
    if (!existingClinicAdminAccount) {
      await db.account.create({
        data: {
          providerId: "credential",
          accountId: user.email,
          userId: user.id,
          password: oanaCredentialHash,
        },
      });
      console.log("Credential account created for clinic admin");
    } else if (existingClinicAdminAccount.providerId !== "credential") {
      await db.account.update({
        where: { id: existingClinicAdminAccount.id },
        data: {
          providerId: "credential",
          password: oanaCredentialHash,
        },
      });
      console.log("Credential account provider updated for clinic admin");
    } else {
      await db.account.update({
        where: { id: existingClinicAdminAccount.id },
        data: { password: oanaCredentialHash },
      });
      console.log("Credential account password synced for clinic admin");
    }
    return { clinic, branch, user };
  } catch (error) {
    console.error("Error in clinicSeed:", error);
    throw error; // Re-throw the error to be caught by the main function
  }
};

const userSeed = async () => {
  try {
    const superPlain = process.env.ECLINIC_SUPER_ADMIN_PASSWORD as string;
    const superCredentialHash = await hashCredentialPassword(superPlain);

    const user = await db.user.upsert({
      where: {
        email: process.env.ECLINIC_SUPER_ADMIN_EMAIL as string,
      },
      update: {},
      create: {
        name: `${process.env.ECLINIC_SUPER_ADMIN_FIRST_NAME} ${process.env.ECLINIC_SUPER_ADMIN_LAST_NAME}`,
        email: process.env.ECLINIC_SUPER_ADMIN_EMAIL as string,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        phone_number: process.env.ECLINIC_SUPER_ADMIN_PHONE_NUMBER as string,
        emailVerified: new Date(),
        phone_number_verified: new Date(),
      },
    });
    console.log("System Admin created successfully:", user);

    // Ensure credential account for email/password auth
    const existingSuperAdminAccount = await db.account.findFirst({
      where: {
        userId: user.id,
        accountId: user.email,
        providerId: { in: ["email", "email-password", "credential"] },
      },
    });
    if (!existingSuperAdminAccount) {
      await db.account.create({
        data: {
          providerId: "credential",
          accountId: user.email,
          userId: user.id,
          password: superCredentialHash,
        },
      });
      console.log("Credential account created for super admin");
    } else if (existingSuperAdminAccount.providerId !== "credential") {
      await db.account.update({
        where: { id: existingSuperAdminAccount.id },
        data: {
          providerId: "credential",
          password: superCredentialHash,
        },
      });
      console.log("Credential account provider updated for super admin");
    } else {
      await db.account.update({
        where: { id: existingSuperAdminAccount.id },
        data: { password: superCredentialHash },
      });
      console.log("Credential account password synced for super admin");
    }
  } catch (error) {
    console.error("Error in userSeed:", error);
    throw error;
  }
};

const insuranceCompanySeed = async () => {
  try {
    const insuranceCompanies = Object.values(InsuranceCompanies);
    const specialInsuranceCompanies = Object.values(SpecialInsurers);
    const allInsuranceCompanies = [
      ...insuranceCompanies,
      ...specialInsuranceCompanies,
    ];
    for (const insuranceCompany of allInsuranceCompanies) {
      await db.insuranceCompany.upsert({
        where: {
          companyName: insuranceCompany,
        },
        update: {},
        create: {
          companyName: insuranceCompany,
        },
      });
    }
    console.log("Insurance companies created successfully");
  } catch (error) {
    console.error(error);
  }
};

// const departmentSeed = async () => {
//   try {
//     const departments = Object.values(DefaultDepartments);
//     for (const department of departments) {
//       await db.clinicalDepartment.upsert({
//         where: { name: department },
//         update: {},
//         create: {
//           name: department,
//           isActive: true,
//         },
//       });
//     }
//     console.log("Departments created successfully");
//   } catch (error) {
//     console.error(error);
//   }
// };

// Main function to run seeds in sequence
async function main() {
  try {
    console.log("Starting seed process...");
    await clinicSeed();
    await userSeed();
    await insuranceCompanySeed();
    // await departmentSeed();
    console.log("Seed process completed successfully");
  } catch (error) {
    console.error("Seed process failed:", error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
