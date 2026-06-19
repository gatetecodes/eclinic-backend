// Pre-submission validation for insurance claims.
//
// Surfaces the issues that cause insurers to bounce claims (uncovered items,
// missing codes, expired cover, missing diagnosis/documents) BEFORE the claim
// is submitted — while the patient is still reachable. Errors block
// submission; warnings are advisory.

export type ClaimValidationSeverity = "error" | "warning";

export type ClaimValidationIssue = {
  code: string;
  severity: ClaimValidationSeverity;
  message: string;
  count?: number;
};

export type ClaimValidationResult = {
  canSubmit: boolean;
  issues: ClaimValidationIssue[];
};

export type ValidatableClaim = {
  items: {
    product: {
      name: string;
      nationalTariffCode: string | null;
      icd11Code: string | null;
      loincCode: string | null;
      insurancePrices: { insuranceCompanyId: number }[];
    };
  }[];
  documents: { id: number }[];
  patientInsurance: {
    insuranceCompanyId: number;
    startDate: Date | null;
    endDate: Date | null;
  } | null;
  visit: { diagnosis: string | null } | null;
};

export function validateClaim(
  claim: ValidatableClaim,
  now: Date = new Date()
): ClaimValidationResult {
  const issues: ClaimValidationIssue[] = [];
  const items = claim.items ?? [];

  if (items.length === 0) {
    issues.push({
      code: "NO_ITEMS",
      severity: "error",
      message: "Claim has no line items.",
    });
  }

  const insurance = claim.patientInsurance;
  if (insurance?.endDate && new Date(insurance.endDate) < now) {
    issues.push({
      code: "INSURANCE_EXPIRED",
      severity: "error",
      message: "The patient's insurance cover has expired.",
    });
  }
  if (insurance?.startDate && new Date(insurance.startDate) > now) {
    issues.push({
      code: "INSURANCE_NOT_STARTED",
      severity: "warning",
      message: "The patient's insurance cover has not started yet.",
    });
  }

  const companyId = insurance?.insuranceCompanyId;
  const uncovered = items.filter(
    (item) =>
      companyId == null ||
      !item.product.insurancePrices.some(
        (price) => price.insuranceCompanyId === companyId
      )
  );
  if (uncovered.length > 0) {
    issues.push({
      code: "UNCOVERED_ITEMS",
      severity: "warning",
      message: `${uncovered.length} item(s) have no negotiated price for this insurer and may be rejected.`,
      count: uncovered.length,
    });
  }

  const missingCode = items.filter(
    (item) =>
      !(
        item.product.nationalTariffCode ||
        item.product.icd11Code ||
        item.product.loincCode
      )
  );
  if (missingCode.length > 0) {
    issues.push({
      code: "MISSING_STANDARD_CODE",
      severity: "warning",
      message: `${missingCode.length} item(s) have no standardized code (national tariff, ICD-11, or LOINC). Rwanda's official tariff lists procedures by name, so a code is recommended but not mandatory.`,
      count: missingCode.length,
    });
  }

  if (!claim.visit?.diagnosis?.trim()) {
    issues.push({
      code: "MISSING_DIAGNOSIS",
      severity: "warning",
      message: "No diagnosis is recorded on the visit.",
    });
  }

  if (!claim.documents || claim.documents.length === 0) {
    issues.push({
      code: "NO_DOCUMENTS",
      severity: "warning",
      message: "No supporting documents are attached to the claim.",
    });
  }

  const canSubmit = !issues.some((issue) => issue.severity === "error");
  return { canSubmit, issues };
}
