import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  activityIntegrityFixtureIds,
  seedProductionDbtFixture,
} from "./activity-data-integrity-dbt-test-helpers.ts";
import { runProcess } from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { encodeActivityRefreshScope } from "./activity-refresh-scope.ts";
import {
  dbtFailureDiagnostic,
  readDbtStatementMessages,
  readDbtStatementTarget,
  withActivityScopeDbtProject,
} from "./activity-refresh-scope-dbt-test-helpers.ts";
import { TEST_USER_ID } from "./schema/core.ts";

const models = [
  "activity_source_records",
  "activity_duplicate_matches",
  "activity_duplicate_groups",
  "deduped_activities",
  "deduped_activity_members",
  "activity_effort_identity",
  "activity_sensor_sample",
  "activity_location_sample",
  "activity_route_identity",
  "activity_step_cadence_rows",
  "activity_sensor_summary_rows",
  "activity_location_summary_rows",
  "activity_stream_points",
  "activity_summary_rows",
  "activity_vo2max_estimate",
];
const maximumQueryBytes = 262144;
const database = `packed_scope_${randomUUID().replaceAll("-", "")}`;
const { wahooActivityId, pelotonActivityId, namedZoneActivityId } = activityIntegrityFixtureIds;
const oldMember = randomUUID();
const newMember = randomUUID();
const foreignMember = randomUUID();
const foreignUser = randomUUID();
const ids = [
  "00010203-0405-0607-0809-0a0b0c0d0e0f",
  "ffeeddcc-bbaa-9988-7766-554433221100",
  wahooActivityId,
  pelotonActivityId,
  namedZoneActivityId,
  oldMember,
  foreignMember,
  ...Array.from({ length: 9993 }, () => randomUUID()),
];
const payload = encodeActivityRefreshScope(ids);
let client: ReturnType<typeof createClient>;
let artifacts: string;
let environment: NodeJS.ProcessEnv;

async function dbt(project: string, name: string, args: string[]) {
  return runProcess(
    "uv",
    [
      "run",
      "--project",
      "analytics",
      "dbt",
      ...args,
      "--project-dir",
      project,
      "--profiles-dir",
      "analytics",
      "--threads",
      "1",
      "--target-path",
      join(artifacts, name),
      "--log-path",
      join(artifacts, `${name}-logs`),
      "--log-format",
      "json",
      "--debug",
      "--no-use-colors",
    ],
    environment,
  );
}

function statementEvidence(query: string) {
  return {
    bytes: Buffer.byteLength(query),
    sha256: createHash("sha256").update(query).digest("hex"),
  };
}

// These are engine tests: no module mocks, no historical migration runner, no local fallback.
describe("packed activity refresh scope on ClickHouse and dbt", () => {
  beforeAll(async () => {
    const connection = process.env.CLICKHOUSE_URL;
    if (!connection)
      throw new Error("CLICKHOUSE_URL is required for packed scope integration tests");
    const url = new URL(connection);
    client = createClient({ url: connection });
    artifacts = await mkdtemp(join(tmpdir(), "packed-scope-engine-"));
    environment = {
      ...process.env,
      DBT_TARGET: "dev",
      DBT_CLICKHOUSE_SCHEMA: database,
      DBT_ANALYTICS_SOURCE_SCHEMA: database,
      DBT_INGEST_SOURCE_SCHEMA: database,
      DBT_POSTGRES_FITNESS_SOURCE_SCHEMA: database,
      DBT_CLICKHOUSE_HOST: url.hostname,
      DBT_CLICKHOUSE_PORT: url.port,
      DBT_CLICKHOUSE_USER: decodeURIComponent(url.username),
      DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(url.password),
      UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
    };
    const result = await client.query({
      query: "SELECT value FROM system.settings WHERE name='max_query_size'",
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ value: String(maximumQueryBytes) }]);
  }, 120_000);
  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
  });

  it("executes every complete materialization and introspection at 10000 IDs with exact decoding and fenced sibling expansion", async () => {
    // Every retry starts with absent targets and fresh artifacts.
    await rm(artifacts, { recursive: true, force: true });
    await mkdir(artifacts);
    await seedProductionDbtFixture(client, database);
    // The shared repair fixture seeds this empty target for runs selecting fewer models.
    // This suite selects its model and consumers through ref(), so dbt must create it.
    await client.command({ query: `DROP TABLE ${database}.activity_location_summary_rows SYNC` });
    await client.insert({
      table: `${database}.activity`,
      format: "JSONEachRow",
      values: [oldMember, newMember, foreignMember].map((id, index) => ({
        id,
        group_id: id,
        provider_id: "apple_health",
        user_id: index === 2 ? foreignUser : TEST_USER_ID,
        external_id: `hk:workout:${id}`,
        canonical_type: "running",
        provider_type: "running",
        started_at: "2026-09-01 08:00:00",
        ended_at: "2026-09-01 08:10:00",
        source_name: "Watch",
        raw: JSON.stringify({
          metadata: {
            HKMetadataKeySyncIdentifier: "packed-scope-sibling",
            HKMetadataKeySyncVersion: index + 1,
          },
        }),
        local_time_source: "unknown",
        _peerdb_synced_at: "2026-09-02 17:00:00",
        _peerdb_version: 1,
        created_at: "2026-09-02 17:00:00",
      })),
    });
    await withActivityScopeDbtProject(
      {
        activity_refresh_user_id: TEST_USER_ID,
        activity_refresh_activity_ids_base64: payload,
        activity_sensor_sample_begin: "2026-09-01",
      },
      async (project) => {
        await writeFile(
          join(project, "scope-test-models", "packed_scope_probe.sql"),
          `
{{ config(materialized='table') }}
{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}
WITH {{ activity_refresh_scope_ctes() }}
1 AS sentinel
SELECT {{ activity_refresh_requested_ids() }} AS requested, {{ activity_refresh_ids() }} AS expanded
`,
        );
        const scopedModels = new Set<string>();
        for (const phase of ["create", "incremental"]) {
          const result = await dbt(project, phase, [
            "run",
            "--event-time-start",
            "2026-09-01",
            "--event-time-end",
            "2026-09-03",
            "--select",
            [...models, "packed_scope_probe"].join(" "),
          ]);
          // Debug stdout is the complete invocation stream. dbt.log rotates at10MiB.
          const statements = readDbtStatementMessages(result.stdout).filter((query) => {
            const target = readDbtStatementTarget(query);
            return target?.database === database && models.includes(target.model);
          });
          const evidence = statements.map((query) => ({
            ...readDbtStatementTarget(query),
            ...statementEvidence(query),
            payloadCopies: query.split(payload).length - 1,
            scoped: query.includes("dofek_refresh_uuid_bytes"),
          }));
          process.stdout.write(`${JSON.stringify({ phase, loggedMaterializations: evidence })}\n`);
          expect(result.exitCode, dbtFailureDiagnostic(result, payload)).toBe(0);
          for (const item of evidence) {
            if (item.payloadCopies === 1 && item.model) scopedModels.add(item.model);
            expect(item.bytes, JSON.stringify(item)).toBeLessThan(maximumQueryBytes);
            expect(item.payloadCopies, JSON.stringify(item)).toBe(item.scoped ? 1 : 0);
          }
          const targets = statements.map(readDbtStatementTarget);
          for (const model of models) {
            for (const operation of phase === "create" ? ["create", "insert"] : ["insert"]) {
              expect(
                targets.some(
                  (target) =>
                    target?.operation === operation &&
                    target.database === database &&
                    target.model === model,
                ),
                `${phase}: missing ${operation} target ${database}.${model}`,
              ).toBe(true);
            }
          }
          // execute/add_query logs include the query comment and model SETTINGS. The
          // adapter's columns_in_query bypasses this logger; exercise that exact wrapper
          // separately, including clickhouse-connect 1.4.1's LIMIT 0 FORMAT JSON path.
          const manifest = z
            .object({
              nodes: z.record(
                z.string(),
                z
                  .object({
                    name: z.string(),
                    compiled_code: z.string().optional(),
                    config: z.object({
                      query_settings: z
                        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                        .optional(),
                    }),
                  })
                  .passthrough(),
              ),
            })
            .parse(JSON.parse(await readFile(join(artifacts, phase, "manifest.json"), "utf8")));
          const introspectionEvidence = [];
          for (const model of models) {
            const node = Object.values(manifest.nodes).find((node) => node.name === model);
            if (!node?.compiled_code) throw new Error(`Missing compiled SQL for ${model}`);
            const query = `SELECT * FROM ( \n${node.compiled_code} \n) LIMIT 0\n FORMAT JSON`;
            const item = { model, ...statementEvidence(query) };
            expect(item.bytes, JSON.stringify(item)).toBeLessThan(maximumQueryBytes);
            const response = await client.command({
              query,
              clickhouse_settings: node.config.query_settings,
            });
            expect(response.query_id).toBeTruthy();
            introspectionEvidence.push(item);
          }
          process.stdout.write(
            `${JSON.stringify({
              phase,
              reconstructedIntrospection: introspectionEvidence,
            })}\n`,
          );
          const decoded = await client.query({
            query: `SELECT requested, expanded FROM ${database}.packed_scope_probe`,
            format: "JSONEachRow",
          });
          const rows = z
            .array(z.object({ requested: z.array(z.string()), expanded: z.array(z.string()) }))
            .parse(await decoded.json());
          expect(rows).toHaveLength(1);
          expect(rows[0]?.requested).toEqual(ids);
          expect(rows[0]?.expanded).toEqual(expect.arrayContaining([oldMember, newMember]));
          // ForeignMember is deliberately in the requested payload. The model user fence
          // must still prevent that foreign activity from appearing in serving output.
          const source = await client.query({
            query: `SELECT activity_id, user_id FROM ${database}.activity_source_records FINAL WHERE is_deleted=0 ORDER BY activity_id`,
            format: "JSONEachRow",
          });
          expect(await source.json()).toEqual(
            [wahooActivityId, pelotonActivityId, namedZoneActivityId, newMember]
              .sort()
              .map((activity_id) => ({ activity_id, user_id: TEST_USER_ID })),
          );
        }
        expect(scopedModels).toEqual(new Set(models));
      },
    );
  }, 300_000);

  it.each([
    ["empty", "", "1 to 10000 packed"],
    ["alphabet", "!".repeat(24), "canonical base64"],
    ["trailing whitespace", `${Buffer.alloc(16).toString("base64")}\n`, "canonical base64"],
    ["invalid padding bits", `${"A".repeat(21)}B==`, "canonical base64"],
    ["truncated quartet", "AAA", "canonical base64"],
    ["partial UUID", Buffer.alloc(17).toString("base64"), "1 to 10000 packed"],
    ["overflow", Buffer.alloc(160016).toString("base64"), "1 to 10000 packed"],
  ])(
    "rejects %s payload at the actual dbt boundary",
    async (name, encoded, message) => {
      await withActivityScopeDbtProject(
        { activity_refresh_user_id: TEST_USER_ID, activity_refresh_activity_ids_base64: encoded },
        async (project) => {
          const result = await dbt(project, `invalid-${name.replaceAll(" ", "-")}`, [
            "run",
            "--select",
            "activity_source_records",
          ]);
          const diagnostic = dbtFailureDiagnostic(result, encoded);
          expect(result.exitCode, diagnostic).not.toBe(0);
          expect((result.stdout + result.stderr).includes(message), diagnostic).toBe(true);
        },
      );
    },
    120_000,
  );
});
