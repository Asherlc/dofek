export function formatCalendarDayCount(days: number): string {
  const absoluteDays = Math.abs(days);
  return `${absoluteDays} calendar ${absoluteDays === 1 ? "day" : "days"}`;
}

export function formatCorrelationLagOption(lag: number): string {
  if (lag === 0) return "Same day";
  return `${Math.sign(lag) === 1 ? "+" : "-"}${formatCalendarDayCount(lag)}`;
}

export function formatCorrelationComparison({
  xLabel,
  yLabel,
  lag,
}: {
  xLabel: string;
  yLabel: string;
  lag: number;
}): string {
  if (lag === 0) return `${xLabel} vs ${yLabel} on the same calendar day`;
  return `${xLabel} today vs ${yLabel} ${formatCalendarDayCount(lag)} ${
    Math.sign(lag) === 1 ? "later" : "earlier"
  }`;
}
