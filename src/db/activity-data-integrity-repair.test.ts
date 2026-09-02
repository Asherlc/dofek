import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
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
  canonical_type: "cycling",
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

const incompatibleMemberSourceRow = {
  ...priorSourceRow,
  activity_id: pelotonId,
  provider_id: "wahoo",
  external_id: "wahoo-workout",
  canonical_type: "running",
};

const priorMatchRows = [
  {
    activity_id: activityId,
    duplicate_activity_id: pelotonId,
    overlap_ratio: 0.95,
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
];

const priorDedupedRows = [
  {
    activity_id: activityId,
    user_id: userId,
    provider_id: "peloton",
    canonical_type: "cycling",
    member_activity_ids: [activityId, pelotonId],
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
];

const priorMemberRows = [
  {
    activity_id: activityId,
    user_id: userId,
    member_activity_id: activityId,
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
];

const priorSensorSummaryRows = [
  {
    activity_id: activityId,
    user_id: userId,
    refresh_version: "9007199254740994",
    is_deleted: 0,
    refreshed_at: "2026-09-02 18:00:00.000000000",
  },
];

const priorSummaryRows = priorSensorSummaryRows.map((row) => ({ ...row }));

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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  repairJournalState.record = null;
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

interface LeaseState {
  held: boolean;
}

interface RepairJournalRecord {
  run_id: string;
  user_id: string;
  artifact_path: string;
  artifact_checksum: string;
  acceptance_owner: string;
  acceptance_deadline: string;
  phase: string;
  created_at: string;
  updated_at: string;
}

const repairJournalState: { record: RepairJournalRecord | null } = { record: null };

function repairJournalQuery(query: SQL): object[] | undefined {
  const rendered = dialect.sqlToQuery(query);
  const normalizedSql = rendered.sql.toLowerCase();
  if (!normalizedSql.includes("fitness.activity_integrity_repair_journal")) return undefined;
  if (normalizedSql.startsWith("select") && normalizedSql.includes("phase in")) {
    const record = repairJournalState.record;
    return record &&
      ["postgres_committed", "rebuild_failed", "executed", "rollback_committed"].includes(
        record.phase,
      )
      ? [record]
      : [];
  }
  if (normalizedSql.startsWith("select")) {
    return repairJournalState.record ? [repairJournalState.record] : [];
  }
  if (normalizedSql.startsWith("insert")) {
    const artifactPath = rendered.params.find(
      (value): value is string => typeof value === "string" && value.endsWith(".audit.json"),
    );
    const artifactChecksum = rendered.params.find(
      (value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    );
    if (!artifactPath || !artifactChecksum)
      throw new Error("journal insert omitted artifact identity");
    repairJournalState.record = {
      run_id: runId,
      user_id: userId,
      artifact_path: artifactPath,
      artifact_checksum: artifactChecksum,
      acceptance_owner: "data-on-call@example.com",
      acceptance_deadline: deadline.toISOString(),
      phase: "postgres_committed",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    return [{ run_id: runId }];
  }
  if (normalizedSql.startsWith("update")) {
    const phase = rendered.params.find(
      (value): value is string =>
        typeof value === "string" &&
        ["rebuild_failed", "executed", "rollback_committed", "rolled_back", "retired"].includes(
          value,
        ),
    );
    if (!repairJournalState.record || !phase) return [];
    repairJournalState.record.phase = phase;
    repairJournalState.record.updated_at = now.toISOString();
    return [{ run_id: repairJournalState.record.run_id }];
  }
  throw new Error(`Unexpected repair journal query: ${rendered.sql}`);
}

function createDatabase(
  execute: (query: SQL) => unknown,
  leaseState: LeaseState = { held: false },
): ActivityIntegrityDatabase {
  const typedExecute = (query: SQL): Promise<unknown> => {
    const journalRows = repairJournalQuery(query);
    return Promise.resolve(journalRows ?? execute(query));
  };
  const database: ActivityIntegrityDatabase = {
    $client: {
      connect: async () => ({
        query: vi.fn(async (query: string) => {
          if (query.includes("pg_try_advisory_lock")) {
            const acquired = !leaseState.held;
            if (acquired) leaseState.held = true;
            return { rows: [{ acquired }] };
          }
          if (query.includes("pg_advisory_unlock")) {
            leaseState.held = false;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          throw new Error(`Unexpected lease query: ${query}`);
        }),
        release: vi.fn(),
      }),
    },
    execute: typedExecute,
    transaction: async <T>(
      operation: (transaction: { execute: typeof typedExecute }) => Promise<T>,
    ) => operation({ execute: typedExecute }),
  };
  return database;
}

function createClickHouse(
  sources: object[][],
  groups: object[][],
  _inserted: Array<{ table: string; values: readonly object[] }> = [],
  rows: {
    mirror?: object[][];
    matches?: object[][];
    deduped?: object[][];
    members?: object[][];
    sensors?: object[][];
    summaries?: object[][];
  } = {},
) {
  return {
    query: vi.fn(async ({ query }: { query: string }) => {
      if (query.includes("postgres_fitness.activity")) return queryRows(rows.mirror?.shift() ?? []);
      if (query.includes("activity_duplicate_matches"))
        return queryRows(rows.matches?.shift() ?? []);
      if (query.includes("activity_duplicate_groups")) return queryRows(groups.shift() ?? []);
      if (query.includes("deduped_activity_members")) return queryRows(rows.members?.shift() ?? []);
      if (query.includes("deduped_activities")) return queryRows(rows.deduped?.shift() ?? []);
      if (query.includes("activity_sensor_summary_rows"))
        return queryRows(rows.sensors?.shift() ?? []);
      if (query.includes("activity_summary_rows")) return queryRows(rows.summaries?.shift() ?? []);
      if (query.includes("activity_source_records")) return queryRows(sources.shift() ?? []);
      throw new Error(`Unexpected ClickHouse query: ${query}`);
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
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
    const clickhouse = createClickHouse([[priorSourceRow]], [priorGroupRows], [], {
      matches: [priorMatchRows],
      deduped: [priorDedupedRows],
      members: [priorMemberRows],
      sensors: [priorSensorSummaryRows],
      summaries: [priorSummaryRows],
    });
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
      schemaVersion: 2,
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
      matchRowsBefore: priorMatchRows,
      sensorSummaryRowsBefore: priorSensorSummaryRows,
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
      expect(rendered.sql).not.toContain("activity.started_at =");
      return [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
      [],
      {
        mirror: [[repairedSourceRow]],
        matches: [priorMatchRows, []],
        deduped: [priorDedupedRows, priorDedupedRows],
        members: [priorMemberRows, priorMemberRows],
        sensors: [priorSensorSummaryRows, priorSensorSummaryRows],
        summaries: [priorSummaryRows, priorSummaryRows],
      },
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

  it("reports current incompatible members during a dry run", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn().mockResolvedValueOnce([postgresCandidate]);
    const clickhouse = createClickHouse(
      [[priorSourceRow, incompatibleMemberSourceRow]],
      [priorGroupRows],
      [],
      {
        matches: [priorMatchRows],
        deduped: [priorDedupedRows],
        members: [priorMemberRows],
        sensors: [priorSensorSummaryRows],
        summaries: [priorSummaryRows],
      },
    );

    await expect(
      repairActivityDataIntegrity(
        createDatabase(execute),
        clickhouse,
        {
          execute: false,
          userId,
          batchSize: 10,
          maxBatches: 1,
          ...window,
        },
        repairDependencies(directory),
      ),
    ).resolves.toMatchObject({ incompatibleMemberCount: 1 });
  });

  it("reports current incompatible members when execute finds no local-time changes", async () => {
    const directory = await artifactDirectory();
    const normalizedCandidate = {
      ...postgresCandidate,
      timezone: null,
      start_utc_offset_minutes: -240,
      end_utc_offset_minutes: -240,
      local_time_source: "provider_offset",
    };
    const execute = vi.fn().mockResolvedValueOnce([normalizedCandidate]);
    const clickhouse = createClickHouse(
      [[repairedSourceRow, incompatibleMemberSourceRow]],
      [priorGroupRows],
      [],
      {
        matches: [priorMatchRows],
        deduped: [priorDedupedRows],
        members: [priorMemberRows],
        sensors: [priorSensorSummaryRows],
        summaries: [priorSummaryRows],
      },
    );

    await expect(
      repairActivityDataIntegrity(
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
        repairDependencies(directory),
      ),
    ).resolves.toMatchObject({ changed: 0, incompatibleMemberCount: 1 });
  });

  it("blocks a sequential write in another directory while the repair journal is eligible", async () => {
    const firstDirectory = await artifactDirectory();
    const secondDirectory = await artifactDirectory();
    const firstDb = createDatabase(vi.fn().mockResolvedValue([{ ...postgresCandidate }]));
    const firstClickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
      [],
      { mirror: [[repairedSourceRow]] },
    );
    const dependencies = repairDependencies(firstDirectory);
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
          artifactDirectory: secondDirectory,
          ...window,
        },
        {
          ...repairDependencies(secondDirectory),
          generateRunId: () => "00000000-0000-4000-8000-000000000778",
        },
      ),
    ).rejects.toThrow("rollback-eligible repair journal");
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("releases global sequential eligibility only after the repair journal is retired", async () => {
    const firstDirectory = await artifactDirectory();
    const secondDirectory = await artifactDirectory();
    const first = await repairActivityDataIntegrity(
      createDatabase(vi.fn().mockResolvedValue([postgresCandidate])),
      createClickHouse(
        [[priorSourceRow], [repairedSourceRow]],
        [priorGroupRows, repairedGroupRows],
        [],
        { mirror: [[repairedSourceRow]] },
      ),
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        artifactDirectory: firstDirectory,
        ...window,
      },
      repairDependencies(firstDirectory),
    );

    await retireActivityDataIntegrityArtifact(
      createDatabase(vi.fn()),
      first.artifactPath,
      { acceptedBy: "data-on-call@example.com", disposition: "accepted" },
      { now: () => now },
    );

    await expect(
      repairActivityDataIntegrity(
        createDatabase(vi.fn().mockResolvedValue([])),
        createClickHouse([], []),
        {
          execute: true,
          userId,
          batchSize: 10,
          maxBatches: 1,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: deadline,
          artifactDirectory: secondDirectory,
          ...window,
        },
        repairDependencies(secondDirectory),
      ),
    ).resolves.toMatchObject({ selected: 0, changed: 0 });
  });

  it("serializes concurrent runs through one database lease even across artifact directories", async () => {
    const firstDirectory = await artifactDirectory();
    const secondDirectory = await artifactDirectory();
    const leaseState = { held: false };
    let releaseSelection: () => void = () => undefined;
    const selectionReleased = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    let reportSelectionStarted: () => void = () => undefined;
    const selectionStarted = new Promise<void>((resolve) => {
      reportSelectionStarted = resolve;
    });
    const firstExecute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      if (rendered.sql.includes("SELECT") && rendered.sql.includes("FROM fitness.activity")) {
        reportSelectionStarted();
        await selectionReleased;
        return [postgresCandidate];
      }
      return [{ id: activityId }];
    });
    const first = repairActivityDataIntegrity(
      createDatabase(firstExecute, leaseState),
      createClickHouse(
        [[priorSourceRow], [repairedSourceRow]],
        [priorGroupRows, repairedGroupRows],
        [],
        {
          mirror: [[repairedSourceRow]],
        },
      ),
      {
        execute: true,
        userId,
        batchSize: 10,
        maxBatches: 1,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: deadline,
        artifactDirectory: firstDirectory,
        ...window,
      },
      repairDependencies(firstDirectory),
    );
    await selectionStarted;

    const secondExecute = vi.fn().mockResolvedValue([]);
    try {
      await expect(
        repairActivityDataIntegrity(
          createDatabase(secondExecute, leaseState),
          createClickHouse([], []),
          {
            execute: true,
            userId,
            batchSize: 10,
            maxBatches: 1,
            acceptanceOwner: "data-on-call@example.com",
            acceptanceDeadline: deadline,
            artifactDirectory: secondDirectory,
            ...window,
          },
          {
            ...repairDependencies(secondDirectory),
            generateRunId: () => "00000000-0000-4000-8000-000000000778",
          },
        ),
      ).rejects.toThrow("activity integrity repair is already running");
      expect(secondExecute).not.toHaveBeenCalled();
    } finally {
      releaseSelection();
      await first;
    }
  });

  it("waits for the bounded PostgreSQL CDC mirror barrier before rebuilding", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      return rendered.sql.includes("FROM fitness.activity")
        ? [postgresCandidate]
        : [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow]],
      [priorGroupRows, repairedGroupRows],
      [],
      { mirror: [[priorSourceRow], [repairedSourceRow]] },
    );
    const sleep = vi.fn(async () => undefined);
    const dependencies = { ...repairDependencies(directory), sleep };

    await repairActivityDataIntegrity(
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

    expect(sleep).toHaveBeenCalledOnce();
    expect(dependencies.rebuildReadModels).toHaveBeenCalledOnce();
  });

  it("fails loudly and records the CDC stage when the mirror readiness deadline expires", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      return rendered.sql.includes("FROM fitness.activity")
        ? [postgresCandidate]
        : [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [priorSourceRow]],
      [priorGroupRows, priorGroupRows],
      [],
      { mirror: [[priorSourceRow]] },
    );
    const dependencies = {
      ...repairDependencies(directory),
      cdcReadinessTimeoutMs: 10,
      monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValue(10),
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      repairActivityDataIntegrity(
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
      ),
    ).rejects.toThrow("CDC mirror did not publish");

    expect(dependencies.rebuildReadModels).not.toHaveBeenCalled();
    const [artifactName] = await readdir(directory);
    expect(
      JSON.parse(await readFile(join(directory, artifactName ?? "missing"), "utf8")),
    ).toMatchObject({
      phase: "rebuild_failed",
      failure: { stage: "cdc_readiness" },
    });
  });

  it("persists a rollback-capable failure phase when the dbt rebuild fails after PostgreSQL commit", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      return rendered.sql.includes("FROM fitness.activity")
        ? [postgresCandidate]
        : [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [repairedSourceRow], [priorSourceRow]],
      [priorGroupRows, repairedGroupRows, priorGroupRows],
      [],
      {
        mirror: [[repairedSourceRow], [priorSourceRow]],
        matches: [priorMatchRows, priorMatchRows, priorMatchRows],
        deduped: [priorDedupedRows, priorDedupedRows, priorDedupedRows],
        members: [priorMemberRows, priorMemberRows, priorMemberRows],
        sensors: [priorSensorSummaryRows, priorSensorSummaryRows, priorSensorSummaryRows],
        summaries: [priorSummaryRows, priorSummaryRows, priorSummaryRows],
      },
    );

    await expect(
      repairActivityDataIntegrity(
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
        repairDependencies(
          directory,
          vi.fn(async () => Promise.reject(new Error("dbt failed"))),
        ),
      ),
    ).rejects.toThrow("dbt failed");

    const [artifactName] = await readdir(directory);
    const artifactPath = join(directory, artifactName ?? "missing");
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toMatchObject({
      phase: "rebuild_failed",
      rollbackEligibility: "eligible",
      failure: { message: "dbt failed" },
    });
    const rollbackRebuildReadModels = vi.fn(async () => undefined);
    await expect(
      rollbackActivityDataIntegrity(createDatabase(execute), clickhouse, artifactPath, {
        now: () => new Date("2026-09-02T20:00:00.000Z"),
        rebuildReadModels: rollbackRebuildReadModels,
      }),
    ).resolves.toMatchObject({ updated: 1 });
    expect(rollbackRebuildReadModels).toHaveBeenCalledWith({
      userId,
      activityIds: [activityId, pelotonId],
    });
  });

  it("recovers from an artifact transition failure through the atomic repair journal", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      return rendered.sql.includes("FROM fitness.activity")
        ? [postgresCandidate]
        : [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [[priorSourceRow], [priorSourceRow]],
      [priorGroupRows, priorGroupRows],
      [],
      {
        mirror: [[priorSourceRow]],
        matches: [priorMatchRows, priorMatchRows],
        deduped: [priorDedupedRows, priorDedupedRows],
        members: [priorMemberRows, priorMemberRows],
        sensors: [priorSensorSummaryRows, priorSensorSummaryRows],
        summaries: [priorSummaryRows, priorSummaryRows],
      },
    );
    const generateRunId = vi
      .fn<() => string>()
      .mockReturnValueOnce(runId)
      .mockReturnValue("missing/replacement");

    await expect(
      repairActivityDataIntegrity(
        createDatabase(execute),
        clickhouse,
        {
          execute: true,
          userId,
          batchSize: 10,
          maxBatches: 1,
          acceptanceOwner: "data-on-call@example.com",
          acceptanceDeadline: deadline,
          artifactDirectory: directory,
          ...window,
        },
        { ...repairDependencies(directory), generateRunId },
      ),
    ).rejects.toThrow();

    const [artifactName] = await readdir(directory);
    const artifactPath = join(directory, artifactName ?? "missing");
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toMatchObject({ phase: "snapshot" });
    expect(repairJournalState.record).toMatchObject({
      artifact_path: artifactPath,
      phase: "postgres_committed",
    });

    const rebuildReadModels = vi.fn(async () => undefined);
    await expect(
      rollbackActivityDataIntegrity(createDatabase(execute), clickhouse, artifactPath, {
        now: () => new Date("2026-09-02T20:00:00.000Z"),
        rebuildReadModels,
      }),
    ).resolves.toMatchObject({ updated: 1 });
    expect(rebuildReadModels).toHaveBeenCalledOnce();
    expect(clickhouse.insert).not.toHaveBeenCalled();
    expect(repairJournalState.record?.phase).toBe("rolled_back");
  });

  it("reports actual incompatible canonical members after the rebuild", async () => {
    const directory = await artifactDirectory();
    const execute = vi.fn(async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      return rendered.sql.includes("FROM fitness.activity")
        ? [postgresCandidate]
        : [{ id: activityId }];
    });
    const clickhouse = createClickHouse(
      [
        [priorSourceRow, incompatibleMemberSourceRow],
        [repairedSourceRow, incompatibleMemberSourceRow],
      ],
      [priorGroupRows, repairedGroupRows],
      [],
      {
        mirror: [[repairedSourceRow]],
        deduped: [priorDedupedRows, priorDedupedRows],
      },
    );

    await expect(
      repairActivityDataIntegrity(
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
        repairDependencies(directory),
      ),
    ).resolves.toMatchObject({ incompatibleMemberCount: 1 });
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
      [],
      { mirror: [[repairedSourceRow]] },
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

  it("restores only captured local-time fields before the CDC barrier and scoped rebuild", async () => {
    const { result, rollbackDb } = await executedArtifact();
    const rebuildReadModels = vi.fn(async () => undefined);
    const clickhouse = createClickHouse([[priorSourceRow]], [priorGroupRows], [], {
      mirror: [[priorSourceRow]],
      matches: [priorMatchRows],
      deduped: [priorDedupedRows],
      members: [priorMemberRows],
      sensors: [priorSensorSummaryRows],
      summaries: [priorSummaryRows],
    });

    await expect(
      rollbackActivityDataIntegrity(rollbackDb, clickhouse, result.artifactPath, {
        now: () => new Date("2026-09-02T20:00:00.000Z"),
        rebuildReadModels,
      }),
    ).resolves.toMatchObject({ updated: 1 });
    expect(rebuildReadModels).toHaveBeenCalledWith({
      userId,
      activityIds: [activityId, pelotonId],
    });
  });

  it("rejects rollback after the named owner retires the artifact", async () => {
    const { result, rollbackDb } = await executedArtifact();
    const receiptPath = await retireActivityDataIntegrityArtifact(
      createDatabase(vi.fn()),
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
