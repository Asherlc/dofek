/** Format a duration in minutes as "Xh Ym" */
export function formatDurationMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

/** Format a duration between two ISO timestamps as "Xh Ym" */
export function formatDurationRange(start: string, end: string | null): string {
  if (!end) return "--";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const totalMinutes = Math.round(ms / 60000);
  return formatDurationMinutes(totalMinutes);
}

/** Format sleep debt in minutes as a human-readable string */
export function formatSleepDebt(minutes: number): string {
  if (minutes <= 0) return "No sleep debt";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const mins = Math.abs(minutes) % 60;
  return `${hours}h ${mins}m debt`;
}

/** Format a decimal hour (e.g. 22.5) as "10:30 PM" */
export function formatHour(decimalHour: number): string {
  const totalMinutes = Math.round(decimalHour * 60);
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}

/** Format sleep debt for inline display: "Xh Ym sleep debt (14 days)" */
export function formatSleepDebtInline(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m sleep debt (14 days)`;
}
