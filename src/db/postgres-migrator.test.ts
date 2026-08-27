import { createHash } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  existsSync: vi.fn(),
  migrate: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readMigrationFiles: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readdirSync: mocks.readdirSync,
  readFileSync: mocks.readFileSync,
}));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles: mocks.readMigrationFiles }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: mocks.migrate }));

import { readBaselineMigration, runDrizzleMigrations } from "./postgres-migrator.ts";

interface TestMigration {
  hash: string;
  sql?: string[];
  tag: string;
  when: number;
}

const approvedLegacyHashes = [
  [
    "0009_metric_stream_id_not_null_primary_key",
    "83bed6b39519a9336b51a07f2d87d4ad9f5ba0b23e3733c38ac5fa0f77fdb137",
  ],
  [
    "0018_migrate_body_measurements_to_metric_stream",
    "038e31f6303354edeaebe25d92981ee90e39743bc844f4692f1a75cbfadadb96",
  ],
  [
    "0021_convert_v_activity_to_view",
    "02b69fee3ba566ecd2c18cb28d40ef7251c8afdb9ae4bcb0d7926cdf148354c2",
  ],
  [
    "0047_sync_log_user_provider_synced_at_index",
    "8198fc0703dfb5d1c399fcc6ded55a4686af5a5bbfd832522829ffe1206bac0f",
  ],
  [
    "0048_mcp_oauth",
    [
      "40680a71",
      "ef18d7f5",
      "463b87ce",
      "5c89ccfe",
      "28f080a3",
      "501c0ebe",
      "5f192ff8",
      "4996c1da",
    ].join(""),
  ],
  [
    "0050_provider_data_deletion_outbox",
    "b0d472bef25f06a80427d2e5b3aea18917ef4c85924580139d7c1a43c15bb3bc",
  ],
  [
    "0052_mcp_oauth_refresh_token_family",
    [
      "2b0da48c",
      "aac47822",
      "4d29ce5e",
      "3f76c467",
      "e3edc903",
      "834d4f14",
      "8074c40e",
      "96f7f8e5",
    ].join(""),
  ],
  [
    "0053_file_upload_state_machine",
    "65d3e9aa5f10924fabc77d1a47bc6dd225a58f7afbe3a9ae9179f3602c8a257f",
  ],
] satisfies ReadonlyArray<readonly [string, string]>;

function setMigrationHistory(migrations: TestMigration[]): void {
  mocks.readFileSync.mockReturnValue(
    JSON.stringify({
      entries: migrations.map((migration) => ({
        tag: migration.tag,
        when: migration.when,
      })),
    }),
  );
  mocks.readMigrationFiles.mockReturnValue(
    migrations.map((migration) => ({
      bps: false,
      folderMillis: migration.when,
      hash: migration.hash,
      sql: migration.sql ?? [],
    })),
  );
}

function makeClient(
  rows: Array<{ content_hash: string | null; created_at: number | string | null; hash: string }>,
): { client: Client; queryMock: ReturnType<typeof vi.fn> } {
  const client = new Client();
  const queryMock = vi.fn().mockImplementation((query: string) => {
    if (query.includes("SELECT hash, created_at, content_hash")) {
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
  client.query = queryMock;
  return { client, queryMock };
}

describe("postgres migrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue("drizzle-database");
    mocks.existsSync.mockReturnValue(false);
    mocks.migrate.mockResolvedValue(undefined);
    mocks.readdirSync.mockReturnValue([]);
    setMigrationHistory([{ hash: "current-hash", tag: "0001_create_table", when: 100 }]);
  });

  it("finds only valid baseline tags and returns their Drizzle metadata", () => {
    const cases = [
      { expected: undefined, tag: "baseline" },
      { expected: undefined, tag: "a_baseline" },
      { expected: undefined, tag: "1_baseline_suffix\ntrailing" },
      { expected: undefined, tag: "prefix_1_baseline" },
      { expected: 101, tag: "1_baseline" },
      { expected: 102, tag: "12_baseline_existing_schema" },
      { expected: 103, tag: "123_baseline_" },
    ];

    for (const testCase of cases) {
      setMigrationHistory([
        { hash: `hash-${testCase.tag}`, tag: testCase.tag, when: testCase.expected ?? 100 },
      ]);
      const baseline = readBaselineMigration("/migrations");
      expect(baseline?.folderMillis).toBe(testCase.expected);
      if (testCase.expected !== undefined) {
        expect(baseline?.hash).toBe(`hash-${testCase.tag}`);
      }
    }

    expect(mocks.readFileSync).toHaveBeenCalledWith("/migrations/meta/_journal.json", "utf8");
    expect(mocks.readMigrationFiles).toHaveBeenLastCalledWith({
      migrationsFolder: "/migrations",
    });
  });

  it("rejects malformed journals and journal entries without SQL files", () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ tag: "0001_bad" }] }));
    expect(() => readBaselineMigration("/migrations")).toThrow();

    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ entries: [{ tag: "0001_missing", when: 100 }] }),
    );
    mocks.readMigrationFiles.mockReturnValue([]);
    expect(() => readBaselineMigration("/migrations")).toThrow(
      "Drizzle journal entry has no SQL migration: 0001_missing",
    );
  });

  it("rejects migration journals whose timestamps are not strictly increasing", async () => {
    setMigrationHistory([
      { hash: "first-current-hash", tag: "0001_first", when: 202 },
      { hash: "second-current-hash", tag: "0002_second", when: 201 },
    ]);
    const { client } = makeClient([]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
      "Migration journal timestamps must be strictly increasing: 0002_second follows 0001_first",
    );
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("reconciles legacy rows and delegates migration execution to Drizzle", async () => {
    setMigrationHistory([
      { hash: "first-current-hash", tag: "0001_first", when: 101 },
      { hash: "second-current-hash", tag: "0002_second", when: 202 },
    ]);
    const { client, queryMock } = makeClient([
      { content_hash: null, created_at: "999", hash: "0001_first.sql" },
      { content_hash: "second-current-hash", created_at: 202, hash: "second-current-hash" },
    ]);

    await runDrizzleMigrations(client, "/migrations");

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("ADD COLUMN IF NOT EXISTS content_hash TEXT"),
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT hash, created_at, content_hash"),
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE drizzle.__drizzle_migrations"),
      [
        ["0001_first.sql", "0002_second.sql"],
        ["first-current-hash", "second-current-hash"],
        [101, 202],
      ],
    );
    expect(mocks.drizzle).toHaveBeenCalledWith(client);
    expect(mocks.migrate).toHaveBeenCalledWith("drizzle-database", {
      migrationsFolder: "/migrations",
    });
  });

  it("reports the migration file and statement while preserving the database error", async () => {
    const failedStatement = "SELECT INVALID MIGRATION";
    const databaseError = new Error('syntax error at or near "INVALID"');
    setMigrationHistory([
      {
        hash: "unrelated-hash",
        sql: ["SELECT UNRELATED"],
        tag: "0001_unrelated",
        when: 100,
      },
      {
        hash: "invalid-hash",
        sql: ["SELECT BEFORE FAILURE", `  ${failedStatement}\n`],
        tag: "0002_invalid",
        when: 200,
      },
    ]);
    mocks.migrate.mockRejectedValue(
      new DrizzleQueryError(`\n${failedStatement}  `, [], databaseError),
    );
    const { client } = makeClient([]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toMatchObject({
      cause: databaseError,
      message:
        `Migration 0002_invalid.sql failed\n` +
        `Database error: ${databaseError.message}\n` +
        `Failed statement:\n${failedStatement}`,
    });
  });

  it("preserves a Drizzle query error when its statement is not in migration history", async () => {
    const queryError = new DrizzleQueryError(
      "SELECT UNTRACKED",
      [],
      new Error("untracked statement failed"),
    );
    mocks.migrate.mockRejectedValue(queryError);
    const { client } = makeClient([]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toBe(queryError);
  });

  it("preserves non-query migration errors", async () => {
    const migrationError = new Error("migration metadata failed");
    mocks.migrate.mockRejectedValue(migrationError);
    const { client } = makeClient([]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toBe(migrationError);
  });

  it("reconciles an applied archived migration without adding it to Drizzle execution", async () => {
    const archivedSql = "DROP VIEW fitness.v_activity;";
    const archivedHash = createHash("sha256").update(archivedSql).digest("hex");
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockReturnValue(["0000_archived.sql", "README.md"]);
    mocks.readFileSync.mockImplementation((path: string) =>
      path.endsWith("0000_archived.sql")
        ? archivedSql
        : JSON.stringify({ entries: [{ tag: "0001_create_table", when: 100 }] }),
    );
    const { client, queryMock } = makeClient([
      { content_hash: archivedHash, created_at: 50, hash: "0000_archived.sql" },
    ]);

    await runDrizzleMigrations(client, "/migrations");

    expect(queryMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM unnest($1::text[], $2::text[])"),
      [["0000_archived.sql"], [archivedHash]],
    );
    expect(mocks.readMigrationFiles).toHaveBeenCalledWith({ migrationsFolder: "/migrations" });
    expect(mocks.migrate).toHaveBeenCalledWith("drizzle-database", {
      migrationsFolder: "/migrations",
    });
  });

  it.each(approvedLegacyHashes)(
    "accepts the approved pre-transaction hash for %s",
    async (tag, legacyHash) => {
      setMigrationHistory([{ hash: `${tag}-current-hash`, tag, when: 100 }]);
      const { client } = makeClient([
        { content_hash: legacyHash, created_at: 90, hash: `${tag}.sql` },
      ]);

      await expect(runDrizzleMigrations(client, "/migrations")).resolves.toBeUndefined();
      expect(mocks.migrate).toHaveBeenCalledOnce();
    },
  );

  it("rejects an unexpected content hash for a legacy filename", async () => {
    setMigrationHistory([{ hash: "actual-current-hash", tag: "0001_first", when: 100 }]);
    const { client } = makeClient([
      { content_hash: "unexpected-applied-hash", created_at: 90, hash: "0001_first.sql" },
    ]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
      "0001_first.sql has changed: expected SHA-256 unexpected-applied-hash, actual SHA-256 actual-current-hash",
    );
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("accepts legacy filenames with no content hash or the current content hash", async () => {
    setMigrationHistory([{ hash: "current-hash", tag: "0001_first", when: 100 }]);

    for (const contentHash of [null, "current-hash"]) {
      const { client } = makeClient([
        { content_hash: contentHash, created_at: 90, hash: "0001_first.sql" },
      ]);
      await expect(runDrizzleMigrations(client, "/migrations")).resolves.toBeUndefined();
    }
  });

  it("accepts an applied Drizzle content hash", async () => {
    setMigrationHistory([{ hash: "current-hash", tag: "0001_first", when: 100 }]);
    const { client } = makeClient([
      { content_hash: "ignored", created_at: 999, hash: "current-hash" },
    ]);

    await expect(runDrizzleMigrations(client, "/migrations")).resolves.toBeUndefined();
  });

  it("reports a changed migration matched by its recorded timestamp", async () => {
    setMigrationHistory([{ hash: "actual-current-hash", tag: "0001_first", when: 100 }]);
    const { client } = makeClient([
      { content_hash: null, created_at: 100, hash: "previous-applied-hash" },
    ]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
      "0001_first.sql has changed: expected SHA-256 previous-applied-hash, actual SHA-256 actual-current-hash",
    );
  });

  it("reports a missing legacy filename", async () => {
    const { client } = makeClient([
      { content_hash: null, created_at: 999, hash: "0000_missing.sql" },
    ]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
      "0000_missing.sql is recorded as applied but is missing",
    );
  });

  it("reports missing hash rows with known and unknown timestamps", async () => {
    for (const createdAt of [999, null]) {
      const { client } = makeClient([
        { content_hash: null, created_at: createdAt, hash: "missing-content-hash" },
      ]);
      const expectedTime = createdAt ?? "an unknown time";
      await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
        `migration tracked at ${expectedTime} is recorded as applied but is missing`,
      );
    }
  });

  it("does not match a null applied timestamp to migration metadata", async () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ entries: [{ tag: "0001_first", when: 100 }] }),
    );
    mocks.readMigrationFiles.mockReturnValue([
      { bps: false, folderMillis: null, hash: "current-hash", sql: [] },
    ]);
    const { client } = makeClient([
      { content_hash: null, created_at: null, hash: "missing-content-hash" },
    ]);

    await expect(runDrizzleMigrations(client, "/migrations")).rejects.toThrow(
      "migration tracked at an unknown time is recorded as applied but is missing",
    );
  });
});
