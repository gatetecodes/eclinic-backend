/**
 * Convert "HH:mm" into minutes since midnight.
 */
export const timeStringToMinutes = (time: string): number => {
  const [h, m] = time.split(":").map((n) => Number.parseInt(String(n), 10));
  return h * 60 + m;
};

/**
 * Resolve a Date object from unknown payload (ISO string or Date).
 * Falls back to current date/time if invalid.
 */
export const resolveTargetDate = (input: unknown): Date => {
  if (typeof input === "string") {
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
  return input instanceof Date ? input : new Date();
};

/**
 * Determine if a user is working "now" based on weekly timesheet summary.
 * The weekly summary is an array of 7 entries with dayOfWeek and windows.
 */
export const isWorkingNowForWeekly = (
  weekly:
    | Array<{
        dayOfWeek: number;
        windows: Array<{
          start: string;
          end: string;
          crossesMidnight: boolean;
        }>;
      }>
    | undefined,
  at: Date
): boolean => {
  if (!weekly || weekly.length === 0) {
    return false;
  }

  const nowMinutes = at.getHours() * 60 + at.getMinutes();
  const today = at.getDay();
  const prevDay =
    new Date(at).setDate(at.getDate() - 1) && new Date(at).getDay();

  // Build a quick lookup for day -> windows
  const dayMap = new Map<
    number,
    Array<{ start: string; end: string; crossesMidnight: boolean }>
  >();
  for (const day of weekly) {
    dayMap.set(day.dayOfWeek, day.windows ?? []);
  }

  const todays = dayMap.get(today) ?? [];
  const prevs = dayMap.get(prevDay as number) ?? [];

  const isNowInWindow = (
    start: string,
    end: string,
    crossesMidnight: boolean
  ): boolean => {
    const s = timeStringToMinutes(start);
    const e = timeStringToMinutes(end);
    if (crossesMidnight) {
      // Today windows: working if now >= start
      return nowMinutes >= s;
    }
    return nowMinutes >= s && nowMinutes < e;
  };

  // Check today's windows
  for (const w of todays) {
    if (isNowInWindow(w.start, w.end, w.crossesMidnight)) {
      return true;
    }
  }
  // Check previous day's windows that spill into today
  for (const w of prevs) {
    if (!w.crossesMidnight) {
      continue;
    }
    const e = timeStringToMinutes(w.end);
    if (nowMinutes < e) {
      return true;
    }
  }
  return false;
};
