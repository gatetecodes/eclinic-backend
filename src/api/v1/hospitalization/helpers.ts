import { addHours } from "date-fns";
import type { WardType } from "../../../../generated/prisma/client";

// Bed-label prefix per ward type, matching the Sano bed board (M-01, S-03, …).
export const WARD_TYPE_PREFIX: Record<WardType, string> = {
  MEDICAL: "M",
  SURGICAL: "S",
  MATERNITY: "MT",
  PAEDIATRIC: "P",
  ICU: "IC",
  GENERAL: "G",
};

export const bedLabel = (wardType: WardType, n: number): string =>
  `${WARD_TYPE_PREFIX[wardType] ?? "B"}-${String(n).padStart(2, "0")}`;

// Ward-round / clinician-review charge and the drug-dose fallback price.
export const REVIEW_CHARGE = 5000;

// Maps a human frequency to a dosing interval in hours. PRN / as-needed returns
// null (no scheduled slots — administered on demand).
const PRN_RE = /prn|as needed|as-needed|once only|stat/;
const EVERY_12H_RE = /12/;
const EVERY_8H_RE = /8/;
const EVERY_6H_RE = /6/;
const EVERY_4H_RE = /4/;
const DAILY_RE = /once|daily|24|od\b/;

export const frequencyIntervalHours = (frequency: string): number | null => {
  const f = frequency.toLowerCase();
  if (PRN_RE.test(f)) {
    return null;
  }
  if (EVERY_12H_RE.test(f)) {
    return 12;
  }
  if (EVERY_8H_RE.test(f)) {
    return 8;
  }
  if (EVERY_6H_RE.test(f)) {
    return 6;
  }
  if (EVERY_4H_RE.test(f)) {
    return 4;
  }
  if (DAILY_RE.test(f)) {
    return 24;
  }
  return 12;
};

// Builds the upcoming administration slots for a new MAR entry.
export const buildMarSchedule = (
  firstDoseAt: Date,
  frequency: string,
  slots: number
): Date[] => {
  const interval = frequencyIntervalHours(frequency);
  if (interval === null) {
    return [];
  }
  const out: Date[] = [];
  for (let i = 0; i < slots; i++) {
    out.push(addHours(firstDoseAt, i * interval));
  }
  return out;
};

type ChargeLike = {
  category: string;
  label: string;
  detail?: string | null;
  amount: number | { toString(): string };
  postedAt?: Date;
};

// Categorised grouping of the running bill in the design's fixed order.
export const CHARGE_CATEGORY_ORDER = [
  "BED",
  "REVIEW",
  "MEDS",
  "LAB",
  "IMAGING",
  "PROCEDURE",
] as const;

export const groupCharges = (charges: ChargeLike[]) => {
  const groups = CHARGE_CATEGORY_ORDER.map((category) => {
    const items = charges.filter((c) => c.category === category);
    if (items.length === 0) {
      return null;
    }
    const total = items.reduce((s, c) => s + Number(c.amount), 0);
    return {
      category,
      total,
      items: items.map((c) => ({
        label: c.label,
        detail: c.detail ?? "",
        amount: Number(c.amount),
      })),
    };
  }).filter(Boolean) as Array<{
    category: string;
    total: number;
    items: Array<{ label: string; detail: string; amount: number }>;
  }>;

  const subtotal = charges.reduce((s, c) => s + Number(c.amount), 0);
  return { groups, subtotal };
};
