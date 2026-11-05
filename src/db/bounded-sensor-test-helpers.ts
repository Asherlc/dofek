import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { compileAnalyticsPageSql } from "../analytics/analytics-model-compiler.ts";
import { deriveAnalyticsPageScope } from "../analytics/analytics-page-scope.ts";
import { claimAnalyticsStream, sealAnalyticsRun } from "../analytics/analytics-work-store.ts";
import {
  type AnalyticsEffect,
  appendAnalyticsDelivery,
  readAnalyticsEffectPage,
} from "../analytics/effect-journal.ts";
import { type AnalyticsStream, journalDeliveryKey } from "../analytics/journal-position.ts";
import type { SourcePlacement } from "../analytics/source-placement.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import { logger } from "../logger.ts";
import {
  buildAccountErasureFenceTableSql,
  buildIngestMetricStreamCreateTableSql,
  buildMetricStreamSourcePlacementIngestSql,
  buildProviderDataGenerationTableSql,
} from "../metric-stream/clickhouse-table.ts";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import { createProcessingOperation } from "../processing/processing-event-store.ts";
import { analyticsWorkSchemaStatements } from "./analytics-work-schema.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import { buildIncrementalDedupedSensorStatements } from "./clickhouse-deduped-sensor.ts";
import { setupTestDatabase } from "./test-helpers.ts";

export const sensorUser = "00000000-0000-4000-8000-000000000001";
export const sensorId = (n: number) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export interface SensorFixtureRow {
  id: string;
  user_id: string;
  activity_id: string | null;
  recorded_at: string;
  channel: string;
  provider_id: string;
  external_id: string | null;
  device_id: string | null;
  source_type: string | null;
  scalar: number | null;
  metadata: string;
  ingested_at: string;
  version: string;
  generation: string;
  is_deleted: number;
}
export function sensorRow(n: number, overrides: Partial<SensorFixtureRow> = {}): SensorFixtureRow {
  return {
    id: sensorId(n),
    user_id: sensorUser,
    activity_id: null,
    recorded_at: "2026-01-01 00:00:00.123456",
    channel: "heart_rate",
    provider_id: "reported",
    external_id: null,
    device_id: null,
    source_type: null,
    scalar: 115,
    metadata: '{"measurement_kind":"direct"}',
    ingested_at: "2026-01-02 00:00:00.123456781",
    version: "9007199254740993",
    generation: "1",
    is_deleted: 0,
    ...overrides,
  };
}
function placement(row: SensorFixtureRow): SourcePlacement {
  return {
    sourceId: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    sourceVersion: row.version,
    generation: row.generation,
    key: {
      userId: row.user_id,
      channel: row.channel,
      recordedAt: `${row.recorded_at.replace(" ", "T")}Z`,
    },
    activityId: row.activity_id,
    deleted: row.is_deleted === 1,
  };
}
export class BoundedSensorFixture {
  readonly database = `bounded_sensor_${randomUUID().replaceAll("-", "")}`;
  get databases(): Readonly<Record<"analytics" | "ingest" | "postgres_fitness", string>> {
    return { analytics: this.database, ingest: this.database, postgres_fitness: this.database };
  }
  readonly queryIds: string[] = [];
  readonly evidencePath = join(mkdtempSync(join(tmpdir(), "bounded-sensor-")), "requests.json");
  readonly requests: {
    queryId: string;
    sql: string;
    state: string;
    firstFatal?: string;
    code?: string;
  }[] = [];
  readonly client: ReturnType<typeof createClient>;
  publicationRevision: string | undefined = "1";
  #postgres: Awaited<ReturnType<typeof setupTestDatabase>> | undefined;
  #operationId = "";
  #runId = "";
  #stream: AnalyticsStream = {
    transport: "kafka",
    epoch: "",
    topic: "fixture",
    partition: 0,
  };
  constructor() {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required");
    this.client = createClient({
      url,
      request_timeout: 120_000,
      clickhouse_settings: {
        max_threads: 1,
        max_memory_usage: "134217728",
        log_queries: 1,
        log_profile_events: 1,
        output_format_json_quote_64bit_integers: 1,
      },
    });
  }
  scope(sql: string): string {
    let scoped = sql;
    for (const [logical, physical] of Object.entries(this.databases))
      scoped = scoped
        .replaceAll(`${logical}.`, `${physical}.`)
        .replaceAll(`\`${logical}\`.`, `\`${physical}\`.`);
    return scoped;
  }
  async command(sql: string): Promise<void> {
    await this.#request(sql, (queryId) =>
      this.client.command({ query: this.scope(sql), query_id: queryId }),
    );
  }
  async read(sql: string): Promise<Record<string, unknown>[]> {
    return this.#request(sql, async (queryId) =>
      (
        await this.client.query({
          query: this.scope(sql),
          query_id: queryId,
          format: "JSONEachRow",
        })
      ).json(),
    );
  }
  #persist(): void {
    writeFileSync(
      this.evidencePath,
      JSON.stringify({ database: this.database, requests: this.requests }, null, 2),
    );
  }
  async #request<T>(sql: string, execute: (queryId: string) => Promise<T>): Promise<T> {
    const queryId = `bounded-sensor-${randomUUID()}`;
    this.queryIds.push(queryId);
    const request: (typeof this.requests)[number] = {
      queryId,
      sql: this.scope(sql),
      state: "dispatched",
      firstFatal: undefined,
      code: undefined,
    };
    this.requests.push(request);
    this.#persist();
    try {
      const result = await execute(queryId);
      request.state = "terminal-success";
      this.#persist();
      return result;
    } catch (error) {
      request.code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      request.state = request.code && /^\d+$/.test(request.code) ? "terminal-error" : "unknown";
      request.firstFatal = error instanceof Error ? error.message : String(error);
      this.#persist();
      throw error;
    }
  }
  async create(): Promise<void> {
    logger.info(`Bounded sensor request ledger: ${this.evidencePath}`);
    this.#postgres = await setupTestDatabase();
    await this.#postgres.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${sensorUser},'Bounded fixture')`,
    );
    const operation = await createProcessingOperation(this.#postgres.db, {
      userId: sensorUser,
      providerId: "test",
      kind: "provider_sync",
      datasetKeys: ["activity"],
    });
    this.#operationId = operation.id;
    for (const database of new Set(Object.values(this.databases)))
      await this.command(`CREATE DATABASE ${database}`);
    await this.command(buildIngestMetricStreamCreateTableSql());
    await this.command(buildProviderDataGenerationTableSql());
    await this.command(buildAccountErasureFenceTableSql());
    for (const sql of analyticsWorkSchemaStatements()) await this.command(sql);
    await this.command(buildMetricStreamSourcePlacementIngestSql());
    for (const sql of buildIncrementalDedupedSensorStatements()) await this.command(sql);
    await this.command(
      `CREATE VIEW analytics.metric_stream_freshness AS SELECT * FROM ingest.metric_stream`,
    );
    await this.createSensorPriorityTables();
    await this.command(`INSERT INTO postgres_fitness.sensor_provider_priority
      (provider_id,channel,priority,_peerdb_is_deleted) VALUES
      ('reported','heart_rate',1,0),('fallback','heart_rate',2,0),('reported','power',1,0)`);
  }
  protected async createSensorPriorityTables(): Promise<void> {
    await this.command(`CREATE TABLE postgres_fitness.sensor_provider_priority
      (provider_id String, channel String, priority UInt16, _peerdb_is_deleted UInt8)
      ENGINE=ReplacingMergeTree ORDER BY (provider_id,channel)`);
    await this.command(`CREATE TABLE postgres_fitness.sensor_device_priority
      (provider_id String, source_name_pattern String, channel String, priority UInt16, _peerdb_is_deleted UInt8)
      ENGINE=ReplacingMergeTree ORDER BY (provider_id,source_name_pattern,channel)`);
  }
  async seed(rows: SensorFixtureRow[]): Promise<void> {
    await this.#request(`INSERT metric_stream (${rows.length} fixture rows)`, (queryId) =>
      this.client.insert({
        table: `${this.databases.ingest}.metric_stream`,
        format: "JSONEachRow",
        values: rows,
        query_id: queryId,
      }),
    );
  }
  #journalClient(): ClickHouseClient {
    return {
      command: (options) =>
        this.#request(options.query, (queryId) =>
          this.client.command({ ...options, query: this.scope(options.query), query_id: queryId }),
        ),
      query: async <T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) => {
        const rows = await this.#request(options.query, async (queryId) =>
          (
            await this.client.query({
              ...options,
              query: this.scope(options.query),
              query_id: queryId,
            })
          ).json<T>(),
        );
        return { json: async () => rows };
      },
      insert: (options) =>
        this.#request(
          `INSERT ${options.table} (${options.values.length} fixture rows)`,
          (queryId) =>
            this.client.insert({
              ...options,
              table: this.scope(options.table),
              values: [...options.values],
              query_id: queryId,
            }),
        ),
    };
  }
  async page(
    effects: { before: SensorFixtureRow | null; after: SensorFixtureRow | null }[],
    publication = "1",
    transport: "kafka" | "pulsar" = "kafka",
    stages: readonly ("scalar" | "dedup")[] = ["scalar", "dedup"],
  ): Promise<void> {
    if (!this.#postgres) throw new Error("Create the bounded fixture before capturing a page");
    this.#stream = {
      transport,
      epoch: randomUUID(),
      topic: "fixture",
      partition: transport === "kafka" ? 0 : -1,
    };
    const position =
      transport === "kafka"
        ? { ...this.#stream, transport: "kafka" as const, offset: "9007199254740993" }
        : analyticsPosition(this.#stream, 9007199254740993n);
    const journal: AnalyticsEffect[] = effects.flatMap((effect, ordinal) => {
      const source = effect.after ?? effect.before;
      if (!source) throw new Error("Fixture effect requires a placement");
      return stages.map((stage) => ({
        stream: this.#stream,
        position,
        cursor: { delivery: journalDeliveryKey(position), effectOrdinal: String(ordinal) },
        stage,
        operationId: null,
        sourceId: source.id,
        sourceVersion: source.version,
        generation: source.generation,
        before: effect.before ? placement(effect.before) : null,
        after: effect.after ? placement(effect.after) : null,
      }));
    });
    await appendAnalyticsDelivery(this.#journalClient(), { position, effects: journal });
    await claimAnalyticsStream(this.#postgres.db, {
      stream: this.#stream,
      ownerId: randomUUID(),
      expectedOwnerId: null,
    });
    await this.#postgres.db.execute(
      sql`UPDATE fitness.analytics_stream_state SET processed=${JSON.stringify(position)}::jsonb WHERE transport=${this.#stream.transport} AND epoch=${this.#stream.epoch} AND topic=${this.#stream.topic} AND partition=${this.#stream.partition}`,
    );
    await this.sealPosition(position);
    this.publicationRevision = publication;
  }
  async sealPosition(position: MetricStreamPosition): Promise<void> {
    if (!this.#postgres) throw new Error("Create the bounded fixture before sealing work");
    this.#stream = {
      transport: position.transport,
      epoch: position.epoch,
      topic: position.topic,
      partition: position.partition,
    };
    this.#runId = randomUUID();
    await sealAnalyticsRun(this.#postgres.db, {
      runId: this.#runId,
      frontiers: [
        { operationId: this.#operationId, datasetKey: "activity", stream: this.#stream, position },
      ],
    });
  }
  get work() {
    if (!this.#postgres) throw new Error("Create the bounded fixture before executing work");
    return {
      database: this.#postgres.db,
      connectionString: this.#postgres.connectionString,
      runId: this.#runId,
      stream: this.#stream,
    };
  }
  async capture(stage: "scalar" | "dedup") {
    if (!this.#postgres) throw new Error("Create the bounded fixture before capturing a page");
    const page = await readAnalyticsEffectPage(
      { clickhouse: this.#journalClient(), database: this.#postgres.db },
      {
        runId: this.#runId,
        stage,
        stream: this.#stream,
        after: null,
        limit: 20,
      },
    );
    const scope = deriveAnalyticsPageScope({
      runId: this.#runId,
      stage,
      stream: this.#stream,
      after: null,
      page,
      publicationRevision: this.publicationRevision,
    });
    if (!scope) throw new Error("Fixture has no advancing page");
    return scope;
  }
  async #compile(stage: "scalar" | "dedup") {
    const scope = await this.capture(stage);
    const overrides = {
      PATH: `${resolve(".venv-analytics/bin")}:${process.env.PATH ?? ""}`,
      DBT_TARGET: "dev",
      DBT_CLICKHOUSE_SCHEMA: this.database,
      DBT_ANALYTICS_SOURCE_SCHEMA: this.databases.analytics,
      DBT_INGEST_SOURCE_SCHEMA: this.databases.ingest,
      DBT_POSTGRES_FITNESS_SOURCE_SCHEMA: this.databases.postgres_fitness,
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      return await compileAnalyticsPageSql({
        stage,
        vars: scope.vars,
        artifactDirectory: dirname(this.evidencePath),
      });
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  async scalar(): Promise<void> {
    const compiled = await this.#compile("scalar");
    await this.command(`INSERT INTO ${compiled.relation} ${compiled.sql}`);
  }
  async dedup(): Promise<Record<string, unknown>[]> {
    const compiled = await this.#compile("dedup");
    return this.read(
      `SELECT * EXCEPT(refresh_version) FROM (${compiled.sql}) ORDER BY user_id,channel,recorded_at`,
    );
  }
  async explain(stage: "scalar" | "dedup"): Promise<void> {
    const compiled = await this.#compile(stage);
    const plan = await this.read(`EXPLAIN indexes=1, projections=1 ${compiled.sql}`);
    writeFileSync(
      join(dirname(this.evidencePath), `${stage}-plan.json`),
      JSON.stringify({ model: compiled.nodeId, sql: compiled.sql, plan }, null, 2),
    );
  }
  async close(): Promise<void> {
    if (this.requests.some((request) => !request.state.startsWith("terminal-"))) {
      await this.client.close();
      await this.#postgres?.db.$client.end();
      throw new Error(
        `Unknown query outcome; preserve ${this.database} and ${this.evidencePath} for settlement`,
      );
    }
    try {
      for (const database of new Set(Object.values(this.databases)))
        await this.command(`DROP DATABASE IF EXISTS ${database} SYNC`);
    } finally {
      await this.client.close();
      await this.#postgres?.cleanup();
    }
  }
}
