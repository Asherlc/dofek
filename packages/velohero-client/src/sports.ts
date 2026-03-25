import type { CanonicalActivityType } from "@dofek/training/training";

export const VELOHERO_SPORT_MAP: Record<string, CanonicalActivityType> = {
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

export function mapVeloHeroSport(sportId: string): CanonicalActivityType {
  return VELOHERO_SPORT_MAP[sportId] ?? "other";
}
