import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";

export function throwAdminControllerError(
  operation: string,
  error: unknown
): never {
  logger.error(operation, { error });
  if (error instanceof AppError) {
    throw error;
  }
  throw new AppError({
    status: httpCodes.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_SERVER_ERROR",
  });
}
