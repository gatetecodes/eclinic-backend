import {
  type Prisma,
  type Role,
  UserStatus,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import { hashCredentialPassword } from "../helpers/auth-helper";
import { logger } from "../lib/logger";

export type CreateStaffAccountInput = {
  name: string;
  email: string;
  phone_number: string;
  clinicId: number;
  branchId?: number | null;
  role: Role;
};

/**
 * Create a staff User plus the matching better-auth credential Account.
 *
 * Extracted so tenant provisioning and operator-driven invitations produce
 * identical accounts — previously only provisionClinic knew the Account row and
 * password-hash steps, and any second caller would have had to duplicate them.
 *
 * Takes a transaction client because both callers create the user alongside other
 * rows that must succeed or fail together.
 *
 * The account starts INVITED with `emailVerified: null`: it cannot sign in until
 * the invitee verifies their address, at which point `afterEmailVerification` in
 * src/lib/auth.ts promotes it to ACTIVE.
 */
export async function createStaffAccount(
  tx: Prisma.TransactionClient,
  input: CreateStaffAccountInput
) {
  const user = await tx.user.create({
    data: {
      name: input.name,
      email: input.email,
      phone_number: input.phone_number,
      clinicId: input.clinicId,
      branchId: input.branchId ?? null,
      role: input.role,
      status: UserStatus.INVITED,
      emailVerified: null,
    },
  });

  await tx.account.create({
    data: {
      providerId: "credential",
      accountId: user.id.toString(),
      userId: user.id,
      password: hashCredentialPassword(
        process.env.DEFAULT_USER_PASSWORD as string
      ),
    },
  });

  return user;
}

/**
 * Promote an INVITED account to ACTIVE once its email is verified — the
 * transition that makes "Invited" a real state rather than a label an account
 * would wear forever.
 *
 * Only INVITED is touched: a re-verification by an already-ACTIVE user is a no-op,
 * and a BLOCKED or INACTIVE account must not be revived by verifying an email.
 */
export async function activateVerifiedStaffAccount(
  userId: number
): Promise<void> {
  try {
    await db.user.updateMany({
      where: { id: userId, status: UserStatus.INVITED },
      data: { status: UserStatus.ACTIVE },
    });
  } catch (error) {
    logger.error("Failed to activate verified account", { userId, error });
  }
}
