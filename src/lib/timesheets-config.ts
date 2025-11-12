let cachedGoLive: Date | undefined | null = null;

const parseGoLive = (): Date | undefined => {
  const iso = process.env.TIMESHEETS_GOLIVE_ISO;
  if (!iso) {
    return;
  }

  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return;
  }

  return new Date(parsed);
};

export const getTimesheetsGoLiveDate = (): Date | undefined => {
  if (cachedGoLive === null) {
    cachedGoLive = parseGoLive();
  }
  return cachedGoLive ?? undefined;
};

export const TIMESHEETS_GOLIVE = getTimesheetsGoLiveDate();
