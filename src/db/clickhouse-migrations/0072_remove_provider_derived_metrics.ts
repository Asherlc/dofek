import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0072_remove_provider_derived_metrics",
    statements: [
      "ALTER TABLE postgres_fitness.daily_metrics DROP COLUMN IF EXISTS stress_high_minutes",
      "ALTER TABLE postgres_fitness.daily_metrics DROP COLUMN IF EXISTS recovery_high_minutes",
      "ALTER TABLE postgres_fitness.daily_metrics DROP COLUMN IF EXISTS resilience_level",
      "ALTER TABLE postgres_fitness.sleep_session DROP COLUMN IF EXISTS sleep_need_baseline_minutes",
      "ALTER TABLE postgres_fitness.sleep_session DROP COLUMN IF EXISTS sleep_need_from_debt_minutes",
      "ALTER TABLE postgres_fitness.sleep_session DROP COLUMN IF EXISTS sleep_need_from_strain_minutes",
      "ALTER TABLE postgres_fitness.sleep_session DROP COLUMN IF EXISTS sleep_need_from_nap_minutes",
    ],
  };
}
