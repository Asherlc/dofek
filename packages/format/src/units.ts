export type UnitSystem = "metric" | "imperial";

// --- Conversion constants ---
const KG_TO_LBS = 2.20462;
const KM_TO_MILES = 0.621371;
const METERS_TO_FEET = 3.28084;
const CM_TO_INCHES = 0.393701;
const KM_PER_MILE = 1 / KM_TO_MILES;

// --- UnitConverter class ---

export class UnitConverter {
  constructor(readonly system: UnitSystem) {}

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

  formatWeight(kg: number): string {
    return `${this.convertWeight(kg).toFixed(1)} ${this.weightLabel}`;
  }

  formatDistance(km: number): string {
    return `${this.convertDistance(km).toFixed(1)} ${this.distanceLabel}`;
  }

  formatElevation(meters: number): string {
    return `${this.convertElevation(meters).toFixed(0)} ${this.elevationLabel}`;
  }

  formatTemperature(celsius: number): string {
    return `${this.convertTemperature(celsius).toFixed(1)} ${this.temperatureLabel}`;
  }

  formatSpeed(kmh: number): string {
    return `${this.convertSpeed(kmh).toFixed(1)} ${this.speedLabel}`;
  }

  formatHeight(cm: number): string {
    return `${this.convertHeight(cm).toFixed(1)} ${this.heightLabel}`;
  }
}

// --- Locale detection ---

const IMPERIAL_COUNTRIES = new Set(["US", "MM", "LR"]);

export function detectUnitSystem(locale: string): UnitSystem {
  const parts = locale.split("-");
  const country = parts[1]?.toUpperCase();
  return country && IMPERIAL_COUNTRIES.has(country) ? "imperial" : "metric";
}
