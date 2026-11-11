import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  const statements = [
    "DROP TABLE IF EXISTS analytics.weekly_training_monotony SYNC",
    "DROP TABLE IF EXISTS analytics.weekly_endurance_ramp_rate SYNC",
    "DROP TABLE IF EXISTS analytics.daily_endurance_load SYNC",
  ];
  return {
    id: "0109_remove_heart_rate_tss",
    statements,
    run: async (client) => {
      for (const query of statements) await client.command({ query });
    },
  };
}
