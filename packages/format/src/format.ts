/** Format a Date as YYYY-MM-DD for API queries. */
export function formatDateYmd(date?: Date): string {
  const d = date ?? new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a duration in minutes as "Xh Ym" */
export function formatDurationMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

/** Parse a timestamp string into a Date, returning null if invalid.
 *  Handles both ISO 8601 and postgres ::text format (space-separated, e.g. "2024-03-20 14:30:00+00")
 *  which Hermes and Safari cannot parse natively. */
export function parseValidDate(value: string): Date | null {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  // Normalize postgres-style timestamps for strict JS engines (Hermes, older Safari):
  // "2026-03-20 19:40:29.678162+00" → "2026-03-20T19:40:29.678+00:00"
  const normalized = value
    .replace(" ", "T")
    .replace(/(\.\d{3})\d*/, "$1")
    .replace(/([+-]\d{2})$/, "$1:00");
  const retried = new Date(normalized);
  return Number.isNaN(retried.getTime()) ? null : retried;
}

/** Format a duration between two ISO timestamps as "Xh Ym" */
export function formatDurationRange(start: string, end: string | null): string {
  if (!end) return "--";
  const startDate = parseValidDate(start);
  const endDate = parseValidDate(end);
  if (!startDate || !endDate) return "--";
  const ms = endDate.getTime() - startDate.getTime();
  if (ms < 0) return "--";
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

/** Format a decimal hour (e.g. 22.5) in the user's locale time format.
 *  Uses 12-hour or 24-hour notation based on device locale.
 *  Pass an explicit locale for deterministic output (e.g. in tests). */
export function formatHour(decimalHour: number, locale?: string): string {
  const totalMinutes = Math.round(decimalHour * 60);
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const date = new Date(2000, 0, 1, hour24, minutes, 0);
  return date
    .toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    .replace(/\u202f/g, " ");
}

/** Format sleep debt for inline display: "Xh Ym sleep debt (14 days)" */
export function formatSleepDebtInline(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m sleep debt (14 days)`;
}

/** Format a Date for user-facing display: "Mon, Jan 1, 2024" */
export function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Check if a Date is today */
export function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/** Format a timestamp as relative time: "5m ago", "2h ago", "3d ago".
 *  Accepts ISO strings, postgres-format strings, or Date objects
 *  (postgres-js returns Date objects on Linux/ARM). */
export function formatRelativeTime(value: string | Date): string | null {
  const date = value instanceof Date ? value : parseValidDate(value);
  if (!date) return null;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format a pace in seconds per km as "M:SS" */
export function formatPace(secondsPerKm: number): string {
  let mins = Math.floor(secondsPerKm / 60);
  let secs = Math.round(secondsPerKm % 60);
  if (secs === 60) {
    mins += 1;
    secs = 0;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Format an ISO string as "Jan 1, 2:30 PM" */
export function formatTime(iso: string): string {
  const d = parseValidDate(iso);
  if (!d) return "--";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Format a number with a fixed number of decimal places. Returns "--" for non-finite values. */
export function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(decimals);
}

/** Format a ratio (0–1) as a percentage string. Returns "--" for non-finite values. */
export function formatPercent(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Format a number with explicit +/- sign prefix. Zero has no sign. Returns "--" for non-finite values. */
export function formatSigned(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "--";
  if (value > 0) return `+${value.toFixed(decimals)}`;
  return value.toFixed(decimals);
}
