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

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

// Bands are contiguous half-open intervals [low, high): a value maps to the
// first band with low <= value < high. Keeping them gapless means decimal
// readings (e.g. 36.05 °C, 91.5 % SpO2) never fall through to a silent 0.
const band = (
  value: number | null,
  bands: [number, number, number][]
): number => {
  if (value === null) {
    return 0;
  }
  for (const [low, high, score] of bands) {
    if (value >= low && value < high) {
      return score;
    }
  }
  return 0;
};

export const computeEws = (v: VitalsInput): number => {
  let score = 0;

  // Respiratory rate (≤8=3, 9–11=1, 12–20=0, 21–24=2, ≥25=3)
  score += band(num(v.respiratoryRate), [
    [NEG_INF, 9, 3],
    [9, 12, 1],
    [12, 21, 0],
    [21, 25, 2],
    [25, POS_INF, 3],
  ]);

  // SpO2 (scale 1) (≤91=3, 92–93=2, 94–95=1, ≥96=0)
  score += band(num(v.spo2), [
    [NEG_INF, 92, 3],
    [92, 94, 2],
    [94, 96, 1],
    [96, POS_INF, 0],
  ]);

  // Temperature (°C) (≤35=3, 35.1–36=1, 36.1–38=0, 38.1–39=1, ≥39.1=2)
  score += band(num(v.temperature), [
    [NEG_INF, 35.1, 3],
    [35.1, 36.1, 1],
    [36.1, 38.1, 0],
    [38.1, 39.1, 1],
    [39.1, POS_INF, 2],
  ]);

  // Systolic blood pressure (≤90=3, 91–100=2, 101–110=1, 111–219=0, ≥220=3)
  score += band(systolic(v.bloodPressure), [
    [NEG_INF, 91, 3],
    [91, 101, 2],
    [101, 111, 1],
    [111, 220, 0],
    [220, POS_INF, 3],
  ]);

  // Heart rate (≤40=3, 41–50=1, 51–90=0, 91–110=1, 111–130=2, ≥131=3)
  score += band(num(v.heartRate), [
    [NEG_INF, 41, 3],
    [41, 51, 1],
    [51, 91, 0],
    [91, 111, 1],
    [111, 131, 2],
    [131, POS_INF, 3],
  ]);

  // Consciousness (AVPU) — anything other than Alert scores 3
  if (v.avpu && !ALERT_RE.test(v.avpu.trim())) {
    score += 3;
  }

  return score;
};
