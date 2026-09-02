import { describe, expect, it } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0071_repair_canonical_activity_type_reads.ts";
import { makeFakeClickHouseMigrationClient } from "./test-helpers.ts";

const backfilledTables = [
  "activity_source_records",
  "activity_summary_rows",
  "cycling_activity",
  "deduped_activities",
];

function lastBackfillIndexOf(statements: string[]): number {
  return statements.reduce(
    (lastIndex, statement, index) =>
      statement.startsWith("ALTER TABLE analytics.") ? index : lastIndex,
    -1,
  );
}

function allServingTablesPresent(): Record<string, number> {
  return {
    "postgres_fitness.activity.provider_type": 1,
    "postgres_fitness.activity.modality": 1,
    ...Object.fromEntries(backfilledTables.map((table) => [`analytics.${table}.provider_type`, 1])),
  };
}

describe("0071_repair_canonical_activity_type_reads statements", () => {
  const statements = createMigration().statements;

  it("drops each stale view before recreating it so the stored body is replaced", () => {
    for (const view of [
      "analytics.v_activity_members",
      "analytics.v_activity",
      "analytics.activity_summary",
    ]) {
      const dropIndex = statements.indexOf(`DROP VIEW IF EXISTS ${view}`);
      const createIndex = statements.findIndex((statement) =>
        statement.startsWith(`CREATE VIEW IF NOT EXISTS ${view}\n`),
      );
      expect(dropIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(dropIndex);
    }
  });

  it("recreates view bodies that read the canonical column instead of the renamed one", () => {
    expect(statements.join("\n")).toContain("assumeNotNull(canonical_type) AS canonical_type");
    expect(statements.join("\n")).not.toContain("activity_type");
  });

  it("recreates the dependent members view after the view it selects from", () => {
    const activityIndex = statements.findIndex((statement) =>
      statement.startsWith("CREATE VIEW IF NOT EXISTS analytics.v_activity\n"),
    );
    const membersIndex = statements.findIndex((statement) =>
      statement.startsWith("CREATE VIEW IF NOT EXISTS analytics.v_activity_members\n"),
    );
    expect(membersIndex).toBeGreaterThan(activityIndex);
  });

  it("replaces any lookup left behind by an interrupted run", () => {
    expect(statements).toContain("DROP TABLE IF EXISTS analytics.activity_provenance_backfill");
  });

  it("keys the lookup by activity id so joinGet can resolve provenance per row", () => {
    expect(statements.join("\n")).toContain("ENGINE = Join(ANY, LEFT, activity_id)");
  });

  it("loads provenance only from live replicated activity rows", () => {
    const insertStatement = statements.find((statement) =>
      statement.startsWith("INSERT INTO analytics.activity_provenance_backfill"),
    );

    expect(insertStatement).toContain("FROM postgres_fitness.activity FINAL");
    expect(insertStatement).toContain("WHERE _peerdb_is_deleted = 0");
  });

  it("reads both provenance columns from the lookup for every serving table", () => {
    for (const table of backfilledTables) {
      const backfillStatement = statements.find((statement) =>
        statement.startsWith(`ALTER TABLE analytics.${table}\n`),
      );

      expect(backfillStatement).toContain(
        "provider_type = nullIf(joinGet('analytics.activity_provenance_backfill', 'provider_type', activity_id), '')",
      );
      expect(backfillStatement).toContain(
        "modality = joinGet('analytics.activity_provenance_backfill', 'modality', activity_id)",
      );
    }
  });

  it("touches only live rows that are still missing provenance", () => {
    const backfillStatement = statements.find((statement) =>
      statement.startsWith("ALTER TABLE analytics.deduped_activities\n"),
    );

    expect(backfillStatement).toContain("WHERE provider_type IS NULL");
    expect(backfillStatement).toContain("AND is_deleted = 0");
  });

  it("waits for each mutation so later statements observe the backfilled rows", () => {
    const backfillStatement = statements.find((statement) =>
      statement.startsWith("ALTER TABLE analytics.cycling_activity\n"),
    );

    expect(backfillStatement).toContain("SETTINGS mutations_sync = 2");
  });

  it("drops the lookup after the last table has been backfilled", () => {
    const lastDropIndex = statements.lastIndexOf(
      "DROP TABLE IF EXISTS analytics.activity_provenance_backfill",
    );

    expect(lastDropIndex).toBeGreaterThan(lastBackfillIndexOf(statements));
  });
});

describe("0071_repair_canonical_activity_type_reads runner", () => {
  it("repairs the views before backfilling the tables they expose", async () => {
    const { client, commands } = makeFakeClickHouseMigrationClient(allServingTablesPresent());

    await createMigration().run?.(client, "");

    const viewIndex = commands.indexOf("DROP VIEW IF EXISTS analytics.activity_summary");
    const backfillIndex = commands.findIndex((command) =>
      command.startsWith("ALTER TABLE analytics.activity_summary_rows"),
    );
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThan(viewIndex);
  });

  it("backfills every serving table that carries provenance columns", async () => {
    const { client, commands } = makeFakeClickHouseMigrationClient(allServingTablesPresent());

    await createMigration().run?.(client, "");

    for (const table of backfilledTables) {
      expect(commands.some((command) => command.startsWith(`ALTER TABLE analytics.${table}`))).toBe(
        true,
      );
    }
  });

  it("drops the lookup once every table has been backfilled", async () => {
    const { client, commands } = makeFakeClickHouseMigrationClient(allServingTablesPresent());

    await createMigration().run?.(client, "");

    const lastDropIndex = commands.lastIndexOf(
      "DROP TABLE IF EXISTS analytics.activity_provenance_backfill",
    );
    expect(lastDropIndex).toBeGreaterThan(lastBackfillIndexOf(commands));
  });

  it("skips dbt-owned tables that do not exist yet", async () => {
    const { client, commands } = makeFakeClickHouseMigrationClient({
      "postgres_fitness.activity.provider_type": 1,
      "postgres_fitness.activity.modality": 1,
      "analytics.activity_summary_rows.provider_type": 1,
    });

    await createMigration().run?.(client, "");

    expect(
      commands.some((command) => command.startsWith("ALTER TABLE analytics.activity_summary_rows")),
    ).toBe(true);
    expect(
      commands.some((command) => command.startsWith("ALTER TABLE analytics.cycling_activity")),
    ).toBe(false);
  });

  it("never builds a lookup when no serving table carries provenance columns", async () => {
    const { client, commands } = makeFakeClickHouseMigrationClient({
      "postgres_fitness.activity.provider_type": 1,
      "postgres_fitness.activity.modality": 1,
    });

    await createMigration().run?.(client, "");

    expect(commands.join("\n")).not.toContain("analytics.activity_provenance_backfill");
    expect(commands.some((command) => command.startsWith("DROP VIEW IF EXISTS"))).toBe(true);
  });

  it("fails loudly when the replicated activity table has no provenance to copy", async () => {
    const { client } = makeFakeClickHouseMigrationClient({
      "postgres_fitness.activity.provider_type": 1,
    });
    const migration = createMigration();

    if (!migration.run) throw new Error("Expected custom migration runner");
    await expect(migration.run(client, "")).rejects.toThrow(
      "postgres_fitness.activity is missing provider_type or modality; apply 0069_canonical_activity_types first",
    );
  });

  it("requires a query-capable client", async () => {
    const migration = createMigration();
    const client: ClickHouseCommandClient = {
      command: async () => {},
    };

    if (!migration.run) throw new Error("Expected custom migration runner");
    await expect(migration.run(client, "")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });
});
