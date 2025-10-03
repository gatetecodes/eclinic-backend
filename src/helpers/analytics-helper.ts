export const calculateTrend = (current: number, previous: number) => {
  if (!previous) {
    return 100;
  }
  return ((current - previous) / previous) * 100;
};
export const calculateTrendText = (current: number, previous: number) => {
  const t = calculateTrend(current, previous);
  return `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`;
};
