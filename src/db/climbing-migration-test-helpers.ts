import type { Client } from "pg";

export async function resetLegacyClimbingTables(client: Client): Promise<void> {
  await client.query(`DROP TABLE fitness.climbing_attempt CASCADE;
    DROP TABLE fitness.climbing_entry CASCADE;
    CREATE TABLE fitness.climbing_entry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES fitness.user_profile(id), provider_id text NOT NULL,
      activity_id uuid, unattached_date date, provider_absent_at timestamptz, external_id text,
      climb_type text NOT NULL, grade_system text NOT NULL, grade text NOT NULL,
      sent boolean, attempt_count integer DEFAULT 1, lead boolean, wall_angle_degrees real,
      hold_type text, route_name text, location_name text, source_name text,
      raw jsonb, created_at timestamptz DEFAULT now(),
      CONSTRAINT climbing_entry_aggregate_pair CHECK ((sent IS NULL) = (attempt_count IS NULL)));
    CREATE TABLE fitness.climbing_attempt (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      climbing_entry_id uuid REFERENCES fitness.climbing_entry(id), attempt_index integer,
      outcome text, failure_reason text);`);
}
