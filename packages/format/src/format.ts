/** Format a Date as YYYY-MM-DD for API queries. */
export function formatDateYmd(date?: Date): string {
  const resolvedDate = date ?? new Date();
  return `${resolvedDate.getFullYear()}-${String(resolvedDate.getMonth() + 1).padStart(2, "0")}-${String(resolvedDate.getDate()).padStart(2, "0")}`;
}

/** Shift a YYYY-MM-DD value by calendar days in the device's local timezone. */
export function shiftDateYmd(value: string, dayOffset: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !Number.isInteger(dayOffset)) {
    throw new Error("Expected a valid YYYY-MM-DD date and an integer day offset");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("Expected a valid YYYY-MM-DD date");
  }

  date.setDate(date.getDate() + dayOffset);
  return formatDateYmd(date);
}

/** Format a date as YYYY-MM-DD in a specific timezone. */
export function formatDateYmdInTimeZone(value: DateInput, timeZone: string): string {
  const date = parseDateInput(value);
  if (!date) return "--";
  const parts = dateTimeFormatter(
    { year: "numeric", month: "2-digit", day: "2-digit" },
    timeZone,
  ).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return "--";
  return `${year}-${month}-${day}`;
}

/** Format a duration in minutes as "Xh Ym" */
export function formatDurationMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

/** Format a duration in seconds as "Xh Ym" or "Xs" for short durations. */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--";
  if (Math.abs(seconds) < 60) {
    const decimals = Number.isInteger(seconds) ? 0 : 1;
    return `${fixedDecimalFormatter(decimals).format(seconds)}s`;
  }
  return formatDurationMinutes(Math.round(seconds / 60));
}

export function formatClimbingAttemptResult(sent: boolean, attemptCount: number): string {
  if (sent) {
    return `Sent in ${attemptCount} ${attemptCount === 1 ? "attempt" : "attempts"}`;
  }
  return `Attempted ${attemptCount} ${attemptCount === 1 ? "time" : "times"}`;
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

type DateInput = Date | number | string;

type DateFormatOptions = {
  timeZone?: string;
};

/** Format a date for compact labels: "Jan 1" */
export function formatDateShort(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(value, { month: "short", day: "numeric" }, options);
}

/** Format a date with year for standard labels: "Jan 1, 2024" */
export function formatDateMedium(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(value, { month: "short", day: "numeric", year: "numeric" }, options);
}

/** Format a date with weekday for prominent labels: "Mon, Jan 1, 2024" */
export function formatDateLong(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(
    value,
    { weekday: "short", month: "short", day: "numeric", year: "numeric" },
    options,
  );
}

/** Format a month label: "January 2024" */
export function formatMonthYear(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(value, { month: "long", year: "numeric" }, options);
}

/** Format a weekday label: "Mon" */
export function formatWeekdayShort(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(value, { weekday: "short" }, options);
}

/** Format a date and time for human display: "Jan 1, 2024, 2:30 PM" */
export function formatDateTime(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(
    value,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    },
    options,
  );
}

/** Format a time-only label: "2:30 PM" */
export function formatTimeOnly(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(value, { hour: "numeric", minute: "2-digit", hour12: true }, options);
}

/** Format a weekday and time label: "Monday, 2:30 PM" */
export function formatWeekdayTime(value: DateInput, options: DateFormatOptions = {}): string {
  return formatDateInput(
    value,
    { weekday: "long", hour: "numeric", minute: "2-digit", hour12: true },
    options,
  );
}

/** Format a Date for user-facing display: "Mon, Jan 1, 2024" */
export function formatDateForDisplay(date: DateInput): string {
  return formatDateLong(date);
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

/** Check if a Date is yesterday */
export function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
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
  return formatDateTime(iso);
}

const dateOnlyValuePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTimeValuePattern = /^(\d{4})-(\d{2})-(\d{2})[ T]/;

/** Format a database/API value for display in table cells and detail modals. */
export function formatTableCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
  if (dateOnlyValuePattern.test(str)) {
    return formatDateMedium(str);
  }
  if (dateTimeValuePattern.test(str) && parseValidDate(str)) {
    return formatDateTime(str);
  }
  return str;
}

/** Format a number with a fixed number of decimal places. Returns "--" for non-finite values. */
export function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "--";
  return fixedDecimalFormatter(decimals).format(value);
}

/** Format a ratio (0–1) as a percentage string. Returns "--" for non-finite values. */
export function formatPercent(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "--";
  return `${fixedDecimalFormatter(decimals).format(value * 100)}%`;
}

/** Format a number with explicit +/- sign prefix. Zero has no sign. Returns "--" for non-finite values. */
export function formatSigned(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "--";
  const formatted = fixedDecimalFormatter(decimals).format(value);
  if (value > 0) return `+${formatted}`;
  return formatted;
}

/** Format a readiness percentage difference with a neutral direction label. */
export function formatReadinessDifference(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value > 0) return `${formatNumber(Math.abs(value), 1)}% higher`;
  if (value < 0) return `${formatNumber(Math.abs(value), 1)}% lower`;
  return "0.0% difference";
}

export function formatAssociationEstimateLabel(estimateLabel: string): string {
  const normalizedLabel = estimateLabel.trim();
  return /^Estimate(?::|\s|$)/.test(normalizedLabel)
    ? normalizedLabel
    : `Estimate: ${normalizedLabel}`;
}

export type NullableNumber = number | null | undefined;

export interface FormattedMeasurementPart {
  type: string;
  value: string;
}

export interface FormattedMeasurement {
  text: string;
  parts: FormattedMeasurementPart[];
}

export type FormattedMeasurementFormatter = (value: NullableNumber) => FormattedMeasurement;

const numberFormatters = new Map<string, Intl.NumberFormat>();
const unitFormatters = new Map<string, Intl.NumberFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const standardDeviationFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});
const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const SUPPORTED_INTL_UNITS = new Set(["gram", "percent", "millisecond"]);

function fixedDecimalFormatter(decimals: number, useGrouping = false): Intl.NumberFormat {
  const key = `${decimals}:${useGrouping}`;
  const existing = numberFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });
  numberFormatters.set(key, formatter);
  return formatter;
}

function fixedUnitFormatter(
  decimals: number,
  unit: string,
  useGrouping = false,
): Intl.NumberFormat | null {
  const key = `${unit}:${decimals}:${useGrouping}`;
  const existing = unitFormatters.get(key);
  if (existing) return existing;
  if (!SUPPORTED_INTL_UNITS.has(unit)) return null;
  const formatter = new Intl.NumberFormat("en-US", {
    style: "unit",
    unit,
    unitDisplay: "short",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });
  unitFormatters.set(key, formatter);
  return formatter;
}

function formatMetricValue(value: NullableNumber, decimals: number, useGrouping = false): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return fixedDecimalFormatter(decimals, useGrouping).format(value);
}

function formatPlaceholderMeasurement(): FormattedMeasurement {
  return { text: "--", parts: [{ type: "nan", value: "--" }] };
}

function formatMetricParts(
  value: NullableNumber,
  decimals: number,
  useGrouping = false,
): FormattedMeasurementPart[] {
  if (value == null || !Number.isFinite(value)) return formatPlaceholderMeasurement().parts;
  return fixedDecimalFormatter(decimals, useGrouping).formatToParts(value);
}

function formatMetricMeasurement(
  value: NullableNumber,
  decimals: number,
  unit: string,
  useGrouping = false,
  separator: "" | " " = " ",
): FormattedMeasurement {
  if (value == null || !Number.isFinite(value)) return formatPlaceholderMeasurement();
  const unitLabel = FALLBACK_UNIT_LABELS.get(unit) ?? unit;
  const parts = [
    ...formatMetricParts(value, decimals, useGrouping),
    ...(separator ? [{ type: "literal", value: separator }] : []),
    { type: "unit", value: unitLabel },
  ];
  return {
    text: parts.map((part) => part.value).join(""),
    parts,
  };
}

function joinFormattedMeasurement(measurement: FormattedMeasurement): string {
  return measurement.text;
}

function formatMetricUnitValue(
  value: NullableNumber,
  decimals: number,
  unit: string,
  useGrouping = false,
): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const formatter = fixedUnitFormatter(decimals, unit, useGrouping);
  if (formatter) return formatter.format(value);
  const unitLabel = FALLBACK_UNIT_LABELS.get(unit) ?? unit;
  return `${formatMetricValue(value, decimals, useGrouping)} ${unitLabel}`;
}

function formatDateInput(
  value: DateInput,
  dateTimeOptions: Intl.DateTimeFormatOptions,
  options: DateFormatOptions,
): string {
  const date = parseDateInput(value);
  if (!date) return "--";
  return dateTimeFormatter(dateTimeOptions, options.timeZone)
    .format(date)
    .replace(/\u202f/g, " ");
}

function dateTimeFormatter(
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  const key = `${JSON.stringify(options)}:${timeZone ?? ""}`;
  const existing = dateTimeFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

function parseDateInput(value: DateInput): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const dateOnlyMatch = dateOnlyPattern.exec(value);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }
  return parseValidDate(value);
}

/** Format nutrition display values such as calories and grams with 0 decimals. */
export function formatNutritionNumber(value: NullableNumber): string {
  return formatMetricValue(value, 0, true);
}

/** Format calorie display values with value and unit separated for UI styling. */
export const formatCaloriesMeasurement: FormattedMeasurementFormatter = (value) =>
  formatMetricMeasurement(value, 0, "kcal", true);

/** Format calorie display values with 0 decimals. */
export function formatCalories(value: NullableNumber): string {
  return joinFormattedMeasurement(formatCaloriesMeasurement(value));
}

/** Format nutrition gram display values with 0 decimals. */
export function formatGrams(value: NullableNumber): string {
  return formatMetricUnitValue(value, 0, "gram", true);
}

const NUTRITION_UNITS = new Map([
  ["g", "gram"],
  ["mg", "milligram"],
  ["mcg", "microgram"],
  ["ml", "milliliter"],
]);

const FALLBACK_UNIT_LABELS = new Map([
  ["milligram", "mg"],
  ["microgram", "mcg"],
  ["milliliter", "mL"],
]);

/** Format nutrition display values with their nutrient unit label. */
export function formatNutritionAmount(value: NullableNumber, unit: string): string {
  if (unit === "kcal") return formatCalories(value);
  const intlUnit = NUTRITION_UNITS.get(unit);
  if (!intlUnit) {
    const formattedValue = formatNutritionNumber(value);
    return formattedValue === "--" ? formattedValue : `${formattedValue} ${unit}`;
  }
  return formatMetricUnitValue(value, 0, intlUnit, true);
}

/** Format body composition display values such as weight, body fat, and lean mass with 1 decimal. */
export function formatBodyCompositionNumber(value: NullableNumber): string {
  return formatMetricValue(value, 1);
}

/** Format body composition percentage display values such as body fat with 1 decimal. */
export function formatBodyCompositionPercent(value: NullableNumber): string {
  return formatMetricUnitValue(value, 1, "percent");
}

/** Format oxygen saturation display values with 0 decimals. */
export function formatSpO2(value: NullableNumber): string {
  return joinFormattedMeasurement(formatSpO2Measurement(value));
}

/** Format oxygen saturation display values with value and unit separated for UI styling. */
export const formatSpO2Measurement: FormattedMeasurementFormatter = (value) =>
  formatMetricMeasurement(value, 0, "%", false, "");

/** Format heart rate variability display values with 0 decimals. */
export function formatHRV(value: NullableNumber): string {
  return joinFormattedMeasurement(formatHRVMeasurement(value));
}

/** Format heart rate variability display values with value and unit separated for UI styling. */
export const formatHRVMeasurement: FormattedMeasurementFormatter = (value) =>
  formatMetricMeasurement(value, 0, "ms");

/** Format a z-score as standard deviations from baseline, preserving its meaningful precision. */
export function formatStandardDeviation(value: NullableNumber): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return standardDeviationFormatter.format(value);
}

/** Format intensity display values with 0 decimals. */
export function formatIntensity(value: NullableNumber): string {
  return formatMetricUnitValue(value, 0, "percent");
}

/** Format training load display values with 0 decimals. */
export function formatTrainingLoad(value: NullableNumber): string {
  return formatMetricValue(value, 0);
}
