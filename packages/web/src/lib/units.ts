export type UnitSystem = "metric" | "imperial";

// --- Conversion constants ---
const KG_TO_LBS = 2.20462;
const KM_TO_MILES = 0.621371;
const METERS_TO_FEET = 3.28084;
const CM_TO_INCHES = 0.393701;

// --- Conversion functions (metric input → selected system output) ---

export function convertWeight(kg: number, system: UnitSystem): number {
  return system === "imperial" ? kg * KG_TO_LBS : kg;
}

export function convertDistance(km: number, system: UnitSystem): number {
  return system === "imperial" ? km * KM_TO_MILES : km;
}

export function convertElevation(meters: number, system: UnitSystem): number {
  return system === "imperial" ? meters * METERS_TO_FEET : meters;
}

export function convertTemperature(celsius: number, system: UnitSystem): number {
  return system === "imperial" ? celsius * (9 / 5) + 32 : celsius;
}

export function convertSpeed(kmh: number, system: UnitSystem): number {
  return system === "imperial" ? kmh * KM_TO_MILES : kmh;
}

export function convertHeight(cm: number, system: UnitSystem): number {
  return system === "imperial" ? cm * CM_TO_INCHES : cm;
}

// --- Unit labels ---

export function weightLabel(system: UnitSystem): string {
  return system === "imperial" ? "lbs" : "kg";
}

export function distanceLabel(system: UnitSystem): string {
  return system === "imperial" ? "mi" : "km";
}

export function elevationLabel(system: UnitSystem): string {
  return system === "imperial" ? "ft" : "m";
}

export function temperatureLabel(system: UnitSystem): string {
  return system === "imperial" ? "°F" : "°C";
}

export function speedLabel(system: UnitSystem): string {
  return system === "imperial" ? "mph" : "km/h";
}

export function heightLabel(system: UnitSystem): string {
  return system === "imperial" ? "in" : "cm";
}

// --- Format helpers (convert + label in one call) ---

export function formatWeight(kg: number, system: UnitSystem): string {
  return `${convertWeight(kg, system).toFixed(1)} ${weightLabel(system)}`;
}

export function formatDistance(km: number, system: UnitSystem): string {
  return `${convertDistance(km, system).toFixed(1)} ${distanceLabel(system)}`;
}

export function formatElevation(meters: number, system: UnitSystem): string {
  return `${convertElevation(meters, system).toFixed(0)} ${elevationLabel(system)}`;
}

export function formatTemperature(celsius: number, system: UnitSystem): string {
  return `${convertTemperature(celsius, system).toFixed(1)} ${temperatureLabel(system)}`;
}

export function formatSpeed(kmh: number, system: UnitSystem): string {
  return `${convertSpeed(kmh, system).toFixed(1)} ${speedLabel(system)}`;
}

export function formatHeight(cm: number, system: UnitSystem): string {
  return `${convertHeight(cm, system).toFixed(1)} ${heightLabel(system)}`;
}

// --- Locale detection ---

const IMPERIAL_COUNTRIES = new Set(["US", "MM", "LR"]);

export function detectUnitSystem(locale: string): UnitSystem {
  const parts = locale.split("-");
  const country = parts[1]?.toUpperCase();
  return country && IMPERIAL_COUNTRIES.has(country) ? "imperial" : "metric";
}
