import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPostgresFitnessRawTableStatements } from "../db/clickhouse-raw-tables.ts";
import { buildIngestMetricStreamCreateTableSql } from "../metric-stream/clickhouse-table.ts";
import { resolveAnalyticsMicrobatchBounds } from "./analytics-microbatch-bounds.ts";

const clickHouseImage = "mirror.gcr.io/clickhouse/clickhouse-server:26.6.1.1193-alpine";
const microbatchModels = [
  "sensor_scalar_sample",
  "deduped_sensor",
  "activity_sensor_sample",
  "activity_location_sample",
] as const;
const batchEventSchema = z.object({
  info: z.object({
    code: z.literal("Q045"),
  }),
  data: z.object({
    batch_index: z.number().int().positive(),
    total_batches: z.number().int().positive(),
    node_info: z.object({
      node_name: z.string(),
    }),
  }),
});

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

describe("analytics microbatch bounds", () => {
  let clickHouseUrl: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(clickHouseImage)
      .withEnvironment({
        CLICKHOUSE_DB: "default",
        CLICKHOUSE_USER: "default",
        CLICKHOUSE_PASSWORD: "health",
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
      })
      .withExposedPorts(8123)
      .start();
    clickHouseUrl = `http://default:health@${container.getHost()}:${container.getMappedPort(8123)}`;

    const clickHouse = createClient({ url: clickHouseUrl });
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        const ping = await clickHouse.ping();
        if (ping.success) {
          break;
        }
        if (attempt === 59) {
          throw new Error("ClickHouse did not become ready in time", { cause: ping.error });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await clickHouse.command({ query: "CREATE DATABASE ingest" });
      await clickHouse.command({ query: "CREATE DATABASE postgres_fitness" });
      await clickHouse.command({ query: "CREATE DATABASE analytics" });
      await clickHouse.command({ query: buildIngestMetricStreamCreateTableSql() });
      for (const statement of buildPostgresFitnessRawTableStatements()) {
        await clickHouse.command({ query: statement });
      }
      await clickHouse.command({
        query: `CREATE TABLE analytics.deduped_activities (
  activity_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_synced_at DateTime64(9, 'UTC'),
  is_deleted UInt8,
  refresh_version UInt64
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`,
      });
      await clickHouse.command({
        query: `CREATE TABLE analytics.deduped_activity_members (
  activity_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_synced_at DateTime64(9, 'UTC'),
  member_activity_id UUID,
  is_deleted UInt8,
  refresh_version UInt64
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, member_activity_id)`,
      });
    } finally {
      await clickHouse.close();
    }
  }, 180_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("schedules one current-day batch per model on an empty ClickHouse database", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "dofek-empty-microbatch-"));
    const clickHouse = createClient({ url: clickHouseUrl });
    try {
      const microbatchBounds = await resolveAnalyticsMicrobatchBounds(clickHouse);
      const dbtResult = await runProcess(
        "uv",
        [
          "run",
          "--project",
          "analytics",
          "dbt",
          "run",
          "--project-dir",
          "analytics",
          "--profiles-dir",
          "analytics",
          "--threads",
          "1",
          "--log-format",
          "json",
          "--no-use-colors",
          "--target-path",
          artifactDirectory,
          "--log-path",
          artifactDirectory,
          "--vars",
          JSON.stringify(microbatchBounds),
          "--select",
          microbatchModels.join(" "),
        ],
        {
          ...process.env,
          DBT_TARGET: "dev",
          DBT_CLICKHOUSE_HOST: new URL(clickHouseUrl).hostname,
          DBT_CLICKHOUSE_PORT: new URL(clickHouseUrl).port,
          DBT_CLICKHOUSE_USER: "default",
          DBT_CLICKHOUSE_PASSWORD: "health",
          UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
        },
      );

      expect(dbtResult.exitCode, dbtResult.stderr || dbtResult.stdout).toBe(0);
      const batchEvents = dbtResult.stdout.split("\n").flatMap((line) => {
        try {
          const result = batchEventSchema.safeParse(JSON.parse(line));
          return result.success ? [result.data.data] : [];
        } catch {
          return [];
        }
      });

      expect(batchEvents).toHaveLength(microbatchModels.length);

      expect(
        Object.fromEntries(
          batchEvents.map((event) => [
            event.node_info.node_name,
            {
              batchIndex: event.batch_index,
              totalBatches: event.total_batches,
            },
          ]),
        ),
      ).toEqual({
        sensor_scalar_sample: { batchIndex: 1, totalBatches: 1 },
        deduped_sensor: { batchIndex: 1, totalBatches: 1 },
        activity_sensor_sample: { batchIndex: 1, totalBatches: 1 },
        activity_location_sample: { batchIndex: 1, totalBatches: 1 },
      });
    } finally {
      await Promise.all([
        clickHouse.close(),
        rm(artifactDirectory, { recursive: true, force: true }),
      ]);
    }
  }, 180_000);
});
