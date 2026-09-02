import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActivityIntegrityDatabase,
  repairActivityDataIntegrity,
  retireActivityDataIntegrityArtifact,
  rollbackActivityDataIntegrity,
} from "./activity-data-integrity-repair.ts";

const dialect = new PgDialect();
const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "2a7c6fa3-32f1-4ae5-9c99-b981c31e289b";
const pelotonId = "00000000-0000-4000-8000-000000000109";
const runId = "00000000-0000-4000-8000-000000000777";
const now = new Date("2026-09-02T19:00:00.000Z");
const deadline = new Date("2026-09-03T19:00:00.000Z");
const window = {
  startAt: new Date("2026-09-01T00:00:00.000Z"),
  endAt: new Date("2026-09-02T00:00:00.000Z"),
};

const postgresCandidate = {
  id: activityId,
  provider_id: "peloton",
  external_id: "workout-1",
  user_id: userId,
  started_at: "2026-09-01T14:55:54.000Z",
  ended_at: "2026-09-01T15:25:54.000Z",
  timezone: "Etc/GMT+4",
  start_utc_offset_minutes: -300,
  end_utc_offset_minutes: -300,
  local_time_source: "provider_timezone",
};

const priorSourceRow = {
  activity_id: activityId,
  provider_id: "peloton",
  user_id: userId,
  external_id: "workout-1",
  timezone: "Etc/GMT+4",
  start_utc_offset_minutes: -300,
  end_utc_offset_minutes: -300,
  local_time_source: "provider_timezone",
  refresh_version: "9007199254740993",
  is_deleted: 0,
  refreshed_at: "2026-09-02 18:00:00.000000000",
};

const repairedSourceRow = {
  ...priorSourceRow,
  timezone: null,
  start_utc_offset_minutes: -240,
  end_utc_offset_minutes: -240,
  local_time_source: "provider_offset",
  refresh_version: "9007199254740995",
  refreshed_at: "2026-09-02 19:01:00.000000000",
};

const priorGroupRows = [
  {
    activity_id: activityId,
    group_id: activityId,
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
  {
    activity_id: pelotonId,
    group_id: activityId,
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
];

const repairedGroupRows = priorGroupRows.map((row) => ({
  ...row,
  group_id: row.activity_id,
  refresh_version: "9007199254740996",
  refreshed_at: "2026-09-02 19:01:00.000000000",
}));

const rolledBackSourceRow = {
  ...priorSourceRow,
  refresh_version: "9007199254740997",
  refreshed_at: "2026-09-02T20:00:00.000Z",
};
const rolledBackGroupRows = priorGroupRows.map((row) => ({
  ...row,
  refresh_version: "9007199254740997",
  refreshed_at: "2026-09-02T20:00:00.000Z",
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function artifactDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "activity-integrity-unit-"));
  temporaryDirectories.push(directory);
  return directory;
}

function queryRows<T extends object>(rows: T[]) {
  return Promise.resolve({ json: async () => rows });
}

function createDatabase(execute: (query: SQL) => unknown): ActivityIntegrityDatabase {
  const typedExecute = (query: SQL): Promise<unknown> => Promise.resolve(execute(query));
  const database: ActivityIntegrityDatabase = {
    execute: typedExecute,
    transaction: async <T>(
      operation: (transaction: { execute: typeof typedExecute }) => Promise<T>,
    ) => operation({ execute: typedExecute }),
  };
  return database;
}

function refreshVersion(row: object): string {
  if (!("refresh_version" in row) || typeof row.refresh_version !== "string") {
    throw new Error("inserted row is missing a decimal refresh_version");
  }
  return row.refresh_version;
}

function createClickHouse(
  sources: object[][],
  groups: object[][],
  inserted: Array<{ table: string; values: readonly object[] }> = [],
) {
  return {
    query: vi.fn(async ({ query }: { query: string }) => {
      if (query.includes("activity_duplicate_groups")) return queryRows(groups.shift() ?? []);
      if (query.includes("deduped_activity_members")) return queryRows([]);
      if (query.includes("deduped_activities")) return queryRows([]);
      if (query.includes("activity_summary_rows")) return queryRows([]);
      if (query.includes("activity_source_records")) return queryRows(sources.shift() ?? []);
      throw new Error(`Unexpected ClickHouse query: ${query}`);
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async ({ table, values }: { table: string; values: readonly object[] }) => {
      inserted.push({ table, values });
    }),
  };
}

function repairDependencies(directory: string, rebuildReadModels = vi.fn(async () => undefined)) {
  return {
    artifactDirectory: directory,
    generateRunId: () => runId,
    now: () => now,
    rebuildReadModels,
  };
}

describe("repairActivityDataIntegrity", () => {
  it("writes a mode-0600 dry-run audit snapshot without mutating either database", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn().mockResolvedValueOnce([postgresCandidate]);
    const clickhouse = createClickHouse([[priorSourceRow]], [priorGroupRows]);
    const dependencies = repairDependencies(directory);

    const result = await repairActivityDataIntegrity(
      createDatabase(execute),
      clickhouse,
      {
        execute: false,
        userId,
        batchSize: 10,
        maxBatches: 1,
        ...window,
      },
      dependencies,
    );

    expect(result).toMatchObject({
      selected: 1,
      changed: 1,
      updated: 0,
      artifactPath: expect.any(String),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(dependencies.rebuildReadModels).not.toHaveBeenCalled();
    expect(clickhouse.insert).not.toHaveBeenCalled();
    expect((await stat(result.artifactPath)).mode & 0o777).toBe(0o600);

    const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      runId,
      phase: "dry_run",
      rollbackEligibility: "not_applicable",
      userId,
      window: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-02T00:00:00.000Z",
      },
      highestDerivedVersion: "9007199254740994",
      postgresActivities: [
        {
          id: activityId,
          prior: {
            timezone: "Etc/GMT+4",
            startUtcOffsetMinutes: -300,
            endUtcOffsetMinutes: -300,
            localTimeSource: "provider_timezone",
          },
          repaired: {
            timezone: null,
            startUtcOffsetMinutes: -240,
            endUtcOffsetMinutes: -240,
            localTimeSource: "provider_offset",
          },
        },
      ],
      componentsBefore: [
        {
          groupId: activityId,
          memberActivityIds: [pelotonId, activityId],
        },
      ],
    });
    expect(await readFile(result.artifactPath, "utf8")).toMatch(/\n$/);
  });

  it("persists the snapshot before CAS updates and rebuilds from the durable dbt model once", async () => {
    const directory = await artifactDirectory();
    const expectedArtifactPath = join(
      directory,
      `${now.toISOString().replaceAll(":", "-")}-${runId}.audit.json`,
    );
    const execute = vi.fn(async (query) => {
      const rendered = dialect.sqlToQuery(query);
      if (rendered.sql.includes("SELECT") && rendered.sql.includes("FROM fitness.activity")) {
        return [postgresCandidate];
      }
      const snapshot = JSON.parse(await readFile(expectedArtifactPath, "utf8"));
      expect(snapshot.phase).toBe("snapshot");
      expect(rendered.sql).toContain("activity.timezone IS NOT DISTINCT FROM");
      expect(rendered.sql).toContain("activity.started_at =");
      return [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
    );
    const dependencies = repairDependencies(directory);

    const result = await repairActivityDataIntegrity(
      createDatabase(execute),
      clickhouse,
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        ...window,
      },
      dependencies,
    );

    expect(result).toMatchObject({ updated: 1, changed: 1, beforeComponentCount: 1 });
    expect(result.afterComponentCount).toBe(2);
    expect(dependencies.rebuildReadModels).toHaveBeenCalledOnce();
    const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      phase: "executed",
      rollbackEligibility: "eligible",
      acceptance: {
        owner: "data-on-call@example.com",
        deadline: deadline.toISOString(),
      },
      execution: {
        updated: 1,
        highestDerivedVersion: "9007199254740996",
      },
    });
  });

  it("is idempotent when the selected Postgres rows already have normalized local-time context", async () => {
    const directory = await artifactDirectory();
    const normalizedCandidate = {
      ...postgresCandidate,
      timezone: null,
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_offset",
    };
    const execute = vi.fn().mockResolvedValueOnce([normalizedCandidate]);
    const clickhouse = createClickHouse([[repairedSourceRow]], [repairedGroupRows]);
    const dependencies = repairDependencies(directory);

    const result = await repairActivityDataIntegrity(
      createDatabase(execute),
      clickhouse,
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        ...window,
      },
      dependencies,
    );

    expect(result).toMatchObject({ selected: 1, changed: 0, updated: 0 });
    expect(dependencies.rebuildReadModels).not.toHaveBeenCalled();
    expect(clickhouse.insert).not.toHaveBeenCalled();
    const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
    expect(artifact).toMatchObject({
      phase: "executed",
      rollbackEligibility: "not_applicable",
      execution: { updated: 0 },
    });
  });

  it("blocks another write run until the prior rollback-eligible artifact is retired", async () => {
    const directory = await artifactDirectory();
    const firstDb = createDatabase(vi.fn().mockResolvedValue([{ ...postgresCandidate }]));
    const firstClickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
    );
    const dependencies = repairDependencies(directory);
    await repairActivityDataIntegrity(
      firstDb,
      firstClickhouse,
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        ...window,
      },
      dependencies,
    );

    const secondExecute = vi.fn();
    const secondDb = createDatabase(secondExecute);
    await expect(
      repairActivityDataIntegrity(
        secondDb,
        createClickHouse([], []),
        {
          execute: true,
          userId,
          batchSize: 10,
          maxBatches: 1,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: deadline,
          ...window,
        },
        { ...dependencies, generateRunId: () => "00000000-0000-4000-8000-000000000778" },
      ),
    ).rejects.toThrow("rollback-eligible audit artifact");
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("requires bounded inputs and explicit acceptance ownership for writes", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn();
    const db = createDatabase(execute);
    const clickhouse = createClickHouse([], []);
    const base = { execute: false, userId, batchSize: 10, maxBatches: 1, ...window };

    await expect(
      repairActivityDataIntegrity(
        db,
        clickhouse,
        { ...base, batchSize: 1_001 },
        repairDependencies(directory),
      ),
    ).rejects.toThrow("batchSize");
    await expect(
      repairActivityDataIntegrity(
        db,
        clickhouse,
        { ...base, maxBatches: 0 },
        repairDependencies(directory),
      ),
    ).rejects.toThrow("maxBatches");
    await expect(
      repairActivityDataIntegrity(
        db,
        clickhouse,
        { ...base, execute: true },
        repairDependencies(directory),
      ),
    ).rejects.toThrow("acceptanceOwner");
    await expect(
      repairActivityDataIntegrity(
        db,
        clickhouse,
        {
          ...base,
          execute: true,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: new Date("2026-09-03T19:00:00.001Z"),
        },
        repairDependencies(directory),
      ),
    ).rejects.toThrow("within 24 hours");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("rollbackActivityDataIntegrity", () => {
  async function executedArtifact(options?: { stalePostgres?: boolean }) {
    const directory = await artifactDirectory();
    const repairDb = createDatabase(vi.fn().mockResolvedValue([postgresCandidate]));
    const clickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
    );
    const result = await repairActivityDataIntegrity(
      repairDb,
      clickhouse,
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        ...window,
      },
      repairDependencies(directory),
    );
    const rollbackDb = createDatabase(
      vi.fn().mockResolvedValue(options?.stalePostgres ? [] : [{ id: activityId }]),
    );
    return { directory, result, rollbackDb };
  }

  it("rejects a stale Postgres CAS before writing captured ClickHouse rows", async () => {
    const { result, rollbackDb } = await executedArtifact({ stalePostgres: true });
    const clickhouse = createClickHouse([[repairedSourceRow]], [repairedGroupRows]);

    await expect(
      rollbackActivityDataIntegrity(rollbackDb, clickhouse, result.artifactPath, {
        now: () => now,
      }),
    ).rejects.toThrow("stale audit artifact");
    expect(clickhouse.insert).not.toHaveBeenCalled();
  });

  it("writes captured values forward with a UInt64 version newer than repair state", async () => {
    const { result, rollbackDb } = await executedArtifact();
    const inserted: Array<{ table: string; values: readonly object[] }> = [];
    const clickhouse = createClickHouse(
      [[repairedSourceRow], [rolledBackSourceRow]],
      [repairedGroupRows, rolledBackGroupRows],
      inserted,
    );

    const rollback = await rollbackActivityDataIntegrity(
      rollbackDb,
      clickhouse,
      result.artifactPath,
      { now: () => new Date("2026-09-02T20:00:00.000Z") },
    );

    expect(rollback.updated).toBe(1);
    const versions = inserted.flatMap(({ values }) =>
      values.map((row) => BigInt(refreshVersion(row))),
    );
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version > 9007199254740996n)).toBe(true);
  });

  it("fails loudly when FINAL does not expose the captured rollback values", async () => {
    const { result, rollbackDb } = await executedArtifact();
    const clickhouse = createClickHouse(
      [[repairedSourceRow], [repairedSourceRow]],
      [repairedGroupRows, repairedGroupRows],
    );

    await expect(
      rollbackActivityDataIntegrity(rollbackDb, clickhouse, result.artifactPath, {
        now: () => new Date("2026-09-02T20:00:00.000Z"),
      }),
    ).rejects.toThrow("FINAL verification");
  });

  it("rejects rollback after the named owner retires the artifact", async () => {
    const { result, rollbackDb } = await executedArtifact();
    const receiptPath = await retireActivityDataIntegrityArtifact(
      result.artifactPath,
      { acceptedBy: "data-on-call@example.com", disposition: "accepted" },
      { now: () => now },
    );

    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    await expect(
      rollbackActivityDataIntegrity(
        rollbackDb,
        createClickHouse([[repairedSourceRow]], [repairedGroupRows]),
        result.artifactPath,
        { now: () => now },
      ),
    ).rejects.toThrow("retired audit artifact");
  });
});
