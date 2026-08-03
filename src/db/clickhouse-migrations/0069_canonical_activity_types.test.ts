import { describe, expect, it } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0069_canonical_activity_types.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

function makeFakeClient(columnCounts: Record<string, number> = {}) {
  const commands: string[] = [];
  const client: ClickHouseCommandClient = {
    command: async ({ query }) => {
      commands.push(query);
    },
    query: async <TRow extends object>({ query_params }: QueryOptions) => ({
      json: async (): Promise<TRow[]> =>
        JSON.parse(
          JSON.stringify([
            {
              column_count:
                columnCounts[
                  `${String(query_params?.database)}.${String(query_params?.table)}.${String(query_params?.column)}`
                ] ?? 0,
            },
          ]),
        ),
    }),
  };
  return { client, commands };
}

describe("0069_canonical_activity_types", () => {
  it("migrates the replicated activity source before rebuilding serving models", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0069_canonical_activity_types");
    expect(migration.statements).toContain(
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS provider_type String DEFAULT canonical_type AFTER canonical_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS modality Nullable(String) AFTER provider_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
    );
  });

  it("normalizes every historical qualifier and preserves the former provider type", () => {
    const sql = createMigration().statements.join("\n");

    expect(sql).toContain("MATERIALIZE COLUMN provider_type");
    expect(sql).toContain("WHEN 'road_cycling' THEN 'road'");
    expect(sql).toContain("WHEN 'road_cycling' THEN 'cycling'");
    expect(sql).toContain("WHEN 'football' THEN 'american_football'");
    expect(sql).toContain("WHEN 'rock_climbing' THEN 'climbing'");
    expect(sql).toContain("ELSE canonical_type");
    expect(sql).toContain("modality = if(modality IS NULL");
    expect(sql).toContain("throwIf(countIf(canonical_type = '') > 0");
  });

  it("runs the legacy-only replicated activity migration", async () => {
    const { client, commands } = makeFakeClient({
      "postgres_fitness.activity.activity_type": 1,
    });

    await createMigration().run?.(client, "");

    expect(commands).toContain(
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
    );
    expect(commands).toContain(
      "ALTER TABLE postgres_fitness.activity MATERIALIZE COLUMN provider_type",
    );
    expect(commands.join("\n")).toContain("canonical_type = CASE canonical_type");
    expect(commands.join("\n")).toContain("SELECT throwIf(countIf(canonical_type = '') > 0");
    expect(commands.join("\n")).toContain("WHERE _peerdb_is_deleted = 0");
  });

  it("fails when the client cannot inspect ClickHouse columns", async () => {
    const migration = createMigration();
    const client: ClickHouseCommandClient = {
      command: async () => {},
    };

    if (!migration.run) throw new Error("Expected custom migration runner");
    await expect(migration.run(client, "")).rejects.toThrow(
      "Canonical activity type migration requires a query-capable client",
    );
  });

  it("fails when the replicated activity table has no type column", async () => {
    const migration = createMigration();
    const { client } = makeFakeClient();

    if (!migration.run) throw new Error("Expected custom migration runner");
    await expect(migration.run(client, "")).rejects.toThrow(
      "postgres_fitness.activity has neither activity_type nor canonical_type",
    );
  });

  it("handles an already-canonical replicated activity table", async () => {
    const { client, commands } = makeFakeClient({
      "postgres_fitness.activity.canonical_type": 1,
      "postgres_fitness.activity.provider_type": 1,
    });

    await createMigration().run?.(client, "");

    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
    );
  });

  it("handles an empty column metadata response as missing schema", async () => {
    const migration = createMigration();
    const client: ClickHouseCommandClient = {
      command: async () => {},
      query: async () => ({ json: async () => [] }),
    };

    if (!migration.run) throw new Error("Expected custom migration runner");
    await expect(migration.run(client, "")).rejects.toThrow(
      "postgres_fitness.activity has neither activity_type nor canonical_type",
    );
  });

  it("runs both-column replication and serving-table branches", async () => {
    const { client, commands } = makeFakeClient({
      "postgres_fitness.activity.activity_type": 1,
      "postgres_fitness.activity.canonical_type": 1,
      "postgres_fitness.activity.provider_type": 1,
      "analytics.activity_source_records.activity_type": 1,
      "analytics.activity_source_records.canonical_type": 0,
      "analytics.activity_source_records.provider_type": 1,
      "analytics.activity_source_records.modality": 1,
      "analytics.activity_summary_rows.activity_type": 0,
      "analytics.activity_summary_rows.canonical_type": 1,
      "analytics.activity_summary_rows.provider_type": 0,
      "analytics.activity_summary_rows.modality": 0,
    });

    await createMigration().run?.(client, "");

    expect(commands).toContain("ALTER TABLE postgres_fitness.activity DROP COLUMN activity_type");
    expect(commands).toContain(
      "ALTER TABLE analytics.activity_source_records RENAME COLUMN activity_type TO canonical_type",
    );
    expect(commands.join("\n")).toContain(
      "ALTER TABLE analytics.activity_source_records\n  UPDATE canonical_type =",
    );
    expect(commands.join("\n")).toContain(
      "ALTER TABLE analytics.activity_summary_rows\n  UPDATE canonical_type =",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE analytics.activity_aerobic_efficiency RENAME COLUMN activity_type TO canonical_type",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE postgres_fitness.activity\n  ADD COLUMN IF NOT EXISTS provider_type String DEFAULT activity_type AFTER canonical_type",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE analytics.activity_aerobic_efficiency\n  UPDATE canonical_type =",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE analytics.activity_aerobic_efficiency\n  ADD COLUMN IF NOT EXISTS provider_type Nullable(String) AFTER canonical_type",
    );
    expect(commands.join("\n")).not.toContain(
      "ALTER TABLE analytics.cycling_activity\n  ADD COLUMN IF NOT EXISTS provider_type Nullable(String) AFTER canonical_type",
    );
    expect(commands.join("\n")).toContain("provider_type Nullable(String) AFTER canonical_type");
    expect(commands.join("\n")).toContain("modality Nullable(String) AFTER provider_type");
  });
});
