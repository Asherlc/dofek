import { formatDateMedium, formatNumber } from "./format.ts";

export const cyclingDurabilityDurations = [
  { value: 10, label: "10 seconds", adjective: "10-second" },
  { value: 60, label: "1 minute", adjective: "1-minute" },
  { value: 300, label: "5 minutes", adjective: "5-minute" },
  { value: 1200, label: "20 minutes", adjective: "20-minute" },
] as const;

export const cyclingDurabilityWorkLevels = [10, 20, 30, 40, 50] as const;

export const cyclingDurabilityTitle = "Power after sustained riding";
export const cyclingDurabilityIntro =
  "Both numbers are your best power for the same effort length. The second counts efforts that start after a set amount of pedaling in that ride.";
export const cyclingDurabilityWorkHelp =
  "Kilojoules (kJ) measure work at the pedals. Harder pedaling adds them faster.";
export const cyclingDurabilityEmpty =
  "No outdoor rides with enough measured power data and a nearby weight reading in this date range.";
export const cyclingDurabilityNoLateEffort =
  "No recorded effort reached this amount of pedaling before it started.";

export function formatDurabilityRange(startDate: string | null, endDate: string): string {
  return startDate ? `${formatDateMedium(startDate)} – ${formatDateMedium(endDate)}` : "All dates";
}

export function formatDurabilityPower(value: number, unit: "watts" | "w_per_kg"): string {
  return unit === "watts" ? `${formatNumber(value, 0)} W` : `${formatNumber(value, 2)} W/kg`;
}

const workFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatDurabilityWork(value: number, weightAdjusted = false): string {
  return `${workFormatter.format(value)} ${weightAdjusted ? "kJ/kg" : "kJ"}`;
}

export function formatDurabilityOffset(value: number): string {
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

export function formatDurabilityWeight(
  kind: "measured" | "interpolated" | "nearest",
  formattedWeight: string,
) {
  const label = {
    measured: "Measured weight",
    interpolated: "Estimated weight from two readings",
    nearest: "Estimated weight from the nearest reading",
  }[kind];
  return `${label} · ${formattedWeight}`;
}
