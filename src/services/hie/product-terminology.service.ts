import { AppError } from "@/lib/app-error";

export type ProductTerminology = {
  terminologyStatus: "DRAFT" | "VERIFIED";
  icd11Code: string | null;
  loincCode: string | null;
  snomedCode: string | null;
  ichiCode: string | null;
  nationalTariffCode: string | null;
};

export type ProductTerminologyCodeField = Exclude<
  keyof ProductTerminology,
  "terminologyStatus"
>;

export function terminologyVerificationFields(
  status: "DRAFT" | "VERIFIED",
  actorId: number,
  verifiedAt = new Date()
) {
  return status === "VERIFIED"
    ? {
        terminologyStatus: status,
        terminologyVerifiedAt: verifiedAt,
        terminologyVerifiedById: actorId,
      }
    : {
        terminologyStatus: status,
        terminologyVerifiedAt: null,
        terminologyVerifiedById: null,
      };
}

export function requireVerifiedTerminology(
  product: ProductTerminology,
  requiredCode: ProductTerminologyCodeField
) {
  if (product.terminologyStatus !== "VERIFIED") {
    throw new AppError({
      status: 409,
      code: "HIE_TERMINOLOGY_NOT_VERIFIED",
      message: "Product terminology must be verified before HIE publication",
    });
  }
  const code = product[requiredCode]?.trim();
  if (!code) {
    throw new AppError({
      status: 409,
      code: "HIE_TERMINOLOGY_CODE_MISSING",
      message: `Verified product terminology is missing ${requiredCode}`,
    });
  }
  return code;
}
