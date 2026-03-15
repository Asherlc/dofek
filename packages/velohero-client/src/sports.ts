export const VELOHERO_SPORT_MAP: Record<string, string> = {
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
  "10": "ball_games",
  "11": "rowing",
  "12": "cycling", // pedelec / e-bike
};

export function mapVeloHeroSport(sportId: string): string {
  return VELOHERO_SPORT_MAP[sportId] ?? "other";
}
