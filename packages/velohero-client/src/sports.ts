import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";

export const VELOHERO_SPORT_MAP: Record<string, LegacyActivityType> = {
  "0": "other",
  "1": "cycling",
  "2": "running",
  "3": "swimming",
  "4": "gym",
  "5": "strength",
  "6": "mountain_biking",
  "7": "hiking",
  "8": "cross_country_skiing",
  "9": "cycling", // velomobil / HPV
  "10": "other",
  "11": "rowing",
  "12": "e_bike_cycling", // pedelec / e-bike
};

export function mapVeloHeroSport(sportId: string): ProviderActivityType {
  return resolveProviderActivityType(sportId, VELOHERO_SPORT_MAP[sportId] ?? "other");
}
