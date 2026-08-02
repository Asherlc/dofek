export type HealthspanTrend = "improving" | "declining" | "stable";

export function formatHealthspanTrendContext(trend: HealthspanTrend): string {
  const label = trend.charAt(0).toUpperCase() + trend.slice(1);
  return `Weekly trend across your recorded scores: ${label}`;
}
