// Early Warning Score (NEWS2-style) computed from a set of ward vitals.
// Inputs are free-unit strings (matching the Triage/observation capture format);
// unparseable values contribute 0. This is a clinical convenience aggregate, not
// a certified device output.

type VitalsInput = {
  temperature?: string | null;
  heartRate?: string | null;
  bloodPressure?: string | null; // "120/80"
  respiratoryRate?: string | null;
  spo2?: string | null;
  avpu?: string | null;
};

const NUMERIC_RE = /-?\d+(\.\d+)?/;
const BP_SEPARATOR_RE = /[/\\]/;
const ALERT_RE = /^a(lert)?$/i;

const num = (v?: string | null): number | null => {
  if (!v) {
    return null;
  }
  const match = String(v).match(NUMERIC_RE);
  if (!match) {
    return null;
  }
  const n = Number.parseFloat(match[0]);
  return Number.isNaN(n) ? null : n;
};

const systolic = (bp?: string | null): number | null => {
  if (!bp) {
    return null;
  }
  const first = String(bp).split(BP_SEPARATOR_RE)[0];
  return num(first);
};

const band = (
  value: number | null,
  bands: [number, number, number][]
): number => {
  if (value === null) {
    return 0;
  }
  for (const [low, high, score] of bands) {
    if (value >= low && value <= high) {
      return score;
    }
  }
  return 0;
};

export const computeEws = (v: VitalsInput): number => {
  let score = 0;

  // Respiratory rate
  score += band(num(v.respiratoryRate), [
    [0, 8, 3],
    [9, 11, 1],
    [12, 20, 0],
    [21, 24, 2],
    [25, 300, 3],
  ]);

  // SpO2 (scale 1)
  score += band(num(v.spo2), [
    [96, 100, 0],
    [94, 95, 1],
    [92, 93, 2],
    [0, 91, 3],
  ]);

  // Temperature (°C)
  score += band(num(v.temperature), [
    [0, 35, 3],
    [35.1, 36, 1],
    [36.1, 38, 0],
    [38.1, 39, 1],
    [39.1, 100, 2],
  ]);

  // Systolic blood pressure
  score += band(systolic(v.bloodPressure), [
    [0, 90, 3],
    [91, 100, 2],
    [101, 110, 1],
    [111, 219, 0],
    [220, 400, 3],
  ]);

  // Heart rate
  score += band(num(v.heartRate), [
    [0, 40, 3],
    [41, 50, 1],
    [51, 90, 0],
    [91, 110, 1],
    [111, 130, 2],
    [131, 400, 3],
  ]);

  // Consciousness (AVPU) — anything other than Alert scores 3
  if (v.avpu && !ALERT_RE.test(v.avpu.trim())) {
    score += 3;
  }

  return score;
};
