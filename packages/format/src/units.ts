import type { FormattedMeasurement, FormattedMeasurementPart, NullableNumber } from "./format.ts";

export type UnitSystem = "metric" | "imperial";

export const POWER_UNIT_LABEL = "W";
export const WORK_UNIT_LABEL = "kJ";

// --- Conversion constants ---
const KG_TO_LBS = 2.20462;
const KM_TO_MILES = 0.621371;
const METERS_TO_FEET = 3.28084;
const CM_TO_INCHES = 0.393701;
const KM_PER_MILE = 1 / KM_TO_MILES;
const numberFormatters = new Map<number, Intl.NumberFormat>();
const unitFormatters = new Map<string, Intl.NumberFormat>();

function formatMeasurementParts(value: number, decimals: number): FormattedMeasurementPart[] {
  const existing = numberFormatters.get(decimals);
  if (existing) return existing.formatToParts(value);
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
  numberFormatters.set(decimals, formatter);
  return formatter.formatToParts(value);
}

function formatPlaceholderMeasurement(): FormattedMeasurement {
  return { text: "--", parts: [{ type: "nan", value: "--" }] };
}

function formatUnitMeasurement(
  value: NullableNumber,
  decimals: number,
  unit: string,
  fallbackLabel: string,
): FormattedMeasurement {
  if (value == null || !Number.isFinite(value)) return formatPlaceholderMeasurement();
  const key = `${unit}:${decimals}`;
  const existing = unitFormatters.get(key);
  if (existing) return formatParts(existing.formatToParts(value));
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("en-US", {
      style: "unit",
      unit,
      unitDisplay: "short",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: false,
    });
  } catch (error) {
    // Expected compatibility fallback for JS runtimes with limited Intl unit support.
    if (error instanceof RangeError) {
      return formatParts([
        ...formatMeasurementParts(value, decimals),
        { type: "literal", value: " " },
        { type: "unit", value: fallbackLabel },
      ]);
    }
    throw error;
  }
  unitFormatters.set(key, formatter);
  return formatParts(formatter.formatToParts(value));
}

function formatParts(parts: FormattedMeasurementPart[]): FormattedMeasurement {
  return {
    text: parts.map((part) => part.value).join(""),
    parts,
  };
}

export function formatMeasurementText(measurement: FormattedMeasurement): string {
  return measurement.text;
}

// --- UnitConverter class ---

export class UnitConverter {
  readonly system: UnitSystem;
  constructor(system: UnitSystem) {
    this.system = system;
  }

  // --- Conversions (metric input → selected system output) ---

  convertWeight(kg: number): number {
    return this.system === "imperial" ? kg * KG_TO_LBS : kg;
  }

  convertDistance(km: number): number {
    return this.system === "imperial" ? km * KM_TO_MILES : km;
  }

  convertElevation(meters: number): number {
    return this.system === "imperial" ? meters * METERS_TO_FEET : meters;
  }

  scaleTemperatureStddev(stddev: number): number {
    return this.system === "imperial" ? stddev * (9 / 5) : stddev;
  }

  convertTemperature(celsius: number): number {
    return this.system === "imperial" ? celsius * (9 / 5) + 32 : celsius;
  }

  convertSpeed(kmh: number): number {
    return this.system === "imperial" ? kmh * KM_TO_MILES : kmh;
  }

  convertHeight(cm: number): number {
    return this.system === "imperial" ? cm * CM_TO_INCHES : cm;
  }

  convertPace(secondsPerKm: number): number {
    return this.system === "imperial" ? secondsPerKm * KM_PER_MILE : secondsPerKm;
  }

  // --- Unit labels ---

  get weightLabel(): string {
    return this.system === "imperial" ? "lbs" : "kg";
  }

  get distanceLabel(): string {
    return this.system === "imperial" ? "mi" : "km";
  }

  get elevationLabel(): string {
    return this.system === "imperial" ? "ft" : "m";
  }

  get temperatureLabel(): string {
    return this.system === "imperial" ? "°F" : "°C";
  }

  get percentageLabel(): string {
    return "%";
  }

  get calorieLabel(): string {
    return "kcal";
  }

  get caloriesPerDayLabel(): string {
    return `${this.calorieLabel}/day`;
  }

  get speedLabel(): string {
    return this.system === "imperial" ? "mph" : "km/h";
  }

  get heightLabel(): string {
    return this.system === "imperial" ? "in" : "cm";
  }

  get paceLabel(): string {
    return this.system === "imperial" ? "/mi" : "/km";
  }

  // --- Format helpers (convert + label in one call) ---

  formatWeight(kg: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      kg == null || !Number.isFinite(kg) ? kg : this.convertWeight(kg),
      1,
      this.system === "imperial" ? "pound" : "kilogram",
      this.weightLabel,
    );
  }

  formatDistance(km: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      km == null || !Number.isFinite(km) ? km : this.convertDistance(km),
      1,
      this.system === "imperial" ? "mile" : "kilometer",
      this.distanceLabel,
    );
  }

  formatElevation(meters: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      meters == null || !Number.isFinite(meters) ? meters : this.convertElevation(meters),
      0,
      this.system === "imperial" ? "foot" : "meter",
      this.elevationLabel,
    );
  }

  formatTemperature(celsius: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      celsius == null || !Number.isFinite(celsius) ? celsius : this.convertTemperature(celsius),
      1,
      this.system === "imperial" ? "fahrenheit" : "celsius",
      this.temperatureLabel,
    );
  }

  formatSpeed(kmh: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      kmh == null || !Number.isFinite(kmh) ? kmh : this.convertSpeed(kmh),
      1,
      this.system === "imperial" ? "mile-per-hour" : "kilometer-per-hour",
      this.speedLabel,
    );
  }

  formatHeartRate(beatsPerMinute: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(beatsPerMinute, 0, "beat-per-minute", "bpm");
  }

  formatHeight(cm: NullableNumber): FormattedMeasurement {
    return formatUnitMeasurement(
      cm == null || !Number.isFinite(cm) ? cm : this.convertHeight(cm),
      1,
      this.system === "imperial" ? "inch" : "centimeter",
      this.heightLabel,
    );
  }
}

// --- Locale detection ---

const IMPERIAL_COUNTRIES = new Set(["US", "MM", "LR"]);

export function detectUnitSystem(locale: string): UnitSystem {
  const parts = locale.split("-");
  const country = parts[1]?.toUpperCase();
  return country && IMPERIAL_COUNTRIES.has(country) ? "imperial" : "metric";
}
