export interface VeloHeroWorkout {
  id: string;
  date_ymd: string;
  start_time: string;
  dur_time: string; // HH:MM:SS
  sport_id: string;
  dist_km: string;
  title?: string;
  ascent?: string;
  descent?: string;
  avg_hr?: string;
  max_hr?: string;
  avg_power?: string;
  max_power?: string;
  avg_cadence?: string;
  max_cadence?: string;
  calories?: string;
  file?: string;
  hide?: string;
}

export interface VeloHeroWorkoutsResponse {
  workouts: VeloHeroWorkout[];
}

export interface VeloHeroSsoResponse {
  session: string;
  "user-id": string;
}
