export const calculateTrend = (current: number, previous: number): number => {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;

  if (previousValue === 0) {
    return currentValue > 0 ? 100 : 0;
  }

  const percentageChange =
    ((currentValue - previousValue) / previousValue) * 100;
  return Number.isNaN(percentageChange) || !Number.isFinite(percentageChange)
    ? 0
    : Number(percentageChange.toFixed(2));
};

export const calculateTrendText = (
  current: number,
  previous: number
): string => {
  const currentValue = current || 0;
  const previousValue = previous || 0;

  if (currentValue === previousValue) {
    return "Same as yesterday";
  }

  const difference = Math.abs(currentValue - previousValue);
  const direction = currentValue > previousValue ? "more than" : "less than";
  return `${difference} ${direction} yesterday`;
};
