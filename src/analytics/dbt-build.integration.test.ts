import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import { runOwnedDbtBuild } from "./dbt-build.ts";

describe("pinned dbt publication completion", () => {
  const client = createClickHouseClientFromEnv();
  const database = `erasure_dbt_${randomUUID().replaceAll("-", "")}`;
  let project: string;
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    project = await mkdtemp(join(tmpdir(), "dofek-owned-dbt-"));
    await mkdir(join(project, "models"));
    await writeFile(
      join(project, "dbt_project.yml"),
      "name: owned_fixture\nversion: '1.0'\nconfig-version: 2\nprofile: dofek\nmodel-paths: [models]\n",
    );
    await client.command({ query: `CREATE DATABASE ${database}` });
  });
  afterAll(async () => {
    try {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    } finally {
      await client.close?.();
      if (project) await rm(project, { recursive: true, force: true });
      await context?.cleanup();
    }
  });
  async function build() {
    const child = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        "analytics",
        "dbt",
        "build",
        "--project-dir",
        project,
        "--profiles-dir",
        "analytics",
        "--target",
        "dev",
        "--threads",
        "1",
        "--target-path",
        join(project, "target"),
        "--select",
        "owned_rows",
      ],
      {
        env: {
          ...process.env,
          UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
          DBT_CLICKHOUSE_SCHEMA: database,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-8192);
      });
    return new Promise<{ code: number; output: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, output }));
    });
  }
  it("uses terminal profile settings and reports a late execution error through actual dbt", async () => {
    const model = join(project, "models", "owned_rows.sql");
    await writeFile(
      model,
      `{{ config(materialized='table',engine='MergeTree()',order_by='n') }}
      SELECT number AS n,toUInt8(getSetting('async_insert')) AS asynchronous,
        toUInt8(getSetting('http_wait_end_of_query')) AS buffered,
        toUInt8(getSetting('send_progress_in_http_headers')) AS progress_headers,
        toUInt8(getSetting('mutations_sync')) AS mutation_completion FROM numbers(3)`,
    );
    const result = await build();
    expect(result.code, result.output).toBe(0);
    const rows = await (
      await client.query({
        query: `SELECT * FROM ${database}.owned_rows ORDER BY n`,
        format: "JSONEachRow",
      })
    ).json();
    expect(rows).toEqual(
      [0, 1, 2].map((n) => ({
        n,
        asynchronous: 0,
        buffered: 1,
        progress_headers: 1,
        mutation_completion: 2,
      })),
    );
    await writeFile(
      model,
      `{{ config(materialized='table',engine='MergeTree()',order_by='n') }}
      SELECT number AS n,throwIf(number>=2000,'owned_fixture_late_error') AS guard,
        sleepEachRow(0.001) AS delayed FROM numbers(2001) SETTINGS max_block_size=1000`,
    );
    const failed = await build();
    expect(failed.code, failed.output).not.toBe(0);
    const artifacts = JSON.parse(
      await readFile(join(project, "target", "run_results.json"), "utf8"),
    );
    expect(artifacts.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "error" })]),
    );
  }, 120000);

  it("retains real child admission until the pinned dbt process and fresh artifacts complete", async () => {
    await writeFile(
      join(project, "models", "owned_rows.sql"),
      `{{ config(materialized='table',engine='MergeTree()',order_by='n') }} SELECT number AS n FROM numbers(3)`,
    );
    const started = createTestBarrier();
    const active = withAnalyticsQueryOwner(
      context.db,
      client,
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "native-dbt-success" },
      (owner) =>
        runOwnedDbtBuild(owner, join(project, "target"), "all", async () => {
          const pending = build();
          expect(
            await context.db.execute(
              sql`SELECT query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${ANALYTICS_PUBLICATION_RESOURCE}`,
            ),
          ).toEqual([{ query_terminal: false }]);
          started.resolve();
          return (await pending).code;
        }),
    );
    await Promise.race([started.promise, active]);
    let entered = false;
    const successor = withAnalyticsQueryOwner(
      context.db,
      client,
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "erasure-after-native-dbt" },
      async () => {
        entered = true;
      },
    );
    await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true), {
      timeout: 10000,
    });
    expect(entered).toBe(false);
    expect(await active).toBe(0);
    await successor;
    expect(entered).toBe(true);
  }, 120000);

  it("keeps a native failed child blocked even after process exit and replacement admission", async () => {
    await writeFile(
      join(project, "models", "owned_rows.sql"),
      `{{ config(materialized='table',engine='MergeTree()',order_by='n') }} SELECT number AS n,throwIf(number>=2000,'owned_child_failure') AS guard,sleepEachRow(0.001) AS delayed FROM numbers(2001) SETTINGS max_block_size=1000`,
    );
    await expect(
      withAnalyticsQueryOwner(
        context.db,
        client,
        { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "native-dbt-failure" },
        async (owner) => {
          const code = await runOwnedDbtBuild(
            owner,
            join(project, "target"),
            "all",
            async () => (await build()).code,
          );
          expect(code).not.toBe(0);
        },
      ),
    ).rejects.toThrow("unknown request outcome");
    expect(
      await context.db.execute(
        sql`SELECT quiescent,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${ANALYTICS_PUBLICATION_RESOURCE}`,
      ),
    ).toEqual([{ quiescent: false, query_terminal: false }]);
    await expect(
      withAnalyticsQueryOwner(
        context.db,
        client,
        { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "erasure-after-failed-child" },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  }, 120000);

  it("retains the durable barrier when the executor dies during a real dbt write", async () => {
    const resourceId = `dbt-parent-loss:${randomUUID()}`;
    await writeFile(
      join(project, "models", "owned_rows.sql"),
      `{{ config(materialized='table',engine='MergeTree()',order_by='n') }} SELECT number AS n,sleepEachRow(0.002) AS erasure_parent_loss_marker FROM numbers(1000)`,
    );
    const script = `
      import {spawn} from 'node:child_process';
      import {createDatabaseFromEnv} from './src/db/index.ts';
      import {createClickHouseClientFromEnv} from './src/db/clickhouse.ts';
      import {withAnalyticsQueryOwner} from './src/analytics/analytics-query-owner.ts';
      import {runOwnedDbtBuild} from './src/analytics/dbt-build.ts';
      const {project,resourceId}=JSON.parse(process.argv[1]);
      const db=createDatabaseFromEnv(),client=createClickHouseClientFromEnv();
      try {
        await withAnalyticsQueryOwner(db,client,{resourceId,intentId:'parent-loss'},
          owner=>runOwnedDbtBuild(owner,project+'/target','all',()=>new Promise((resolve,reject)=>{
            const child=spawn('uv',['run','--frozen','--project','analytics','dbt','build','--project-dir',project,'--profiles-dir','analytics','--target','dev','--threads','1','--target-path',project+'/target','--select','owned_rows'],{stdio:'ignore',env:process.env});
            child.once('spawn',()=>process.send({dbtPid:child.pid}));
            child.once('error',reject); child.once('close',code=>resolve(code??1));
          })));
      } finally {await client.close();await db.$client.end();}
    `;
    const parent = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({ project, resourceId }),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: context.connectionString,
          DBT_CLICKHOUSE_SCHEMA: database,
          UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exited = once(parent, "exit");
    let dbtPid: number | undefined;
    let dbtFinished = false;
    const terminateDbt = () => {
      if (dbtPid === undefined || dbtFinished) return;
      try {
        process.kill(dbtPid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    parent.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "dbtPid" in message &&
        typeof message.dbtPid === "number"
      )
        dbtPid = message.dbtPid;
    });
    try {
      await vi.waitFor(
        async () => {
          expect(dbtPid).toBeTypeOf("number");
          const rows = await (
            await client.query({
              query:
                "SELECT query_id FROM system.processes WHERE query LIKE '%erasure_parent_loss_marker%' AND query NOT LIKE '%system.processes%'",
              format: "JSONEachRow",
            })
          ).json();
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 20000, interval: 25 },
      );
      parent.kill("SIGTERM");
      await exited;
      await expect(
        withAnalyticsQueryOwner(
          context.db,
          client,
          { resourceId, intentId: "replacement" },
          async () => undefined,
        ),
      ).rejects.toThrow("verified recovery");
      expect(
        await context.db.execute(
          sql`SELECT quiescent,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        ),
      ).toEqual([{ quiescent: false, query_terminal: false }]);
      const pid = dbtPid;
      if (pid === undefined) throw new Error("Missing admitted dbt process");
      await vi.waitFor(
        () => {
          try {
            process.kill(pid, 0);
            throw new Error("Owned dbt child is still finishing");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        },
        { timeout: 20000 },
      );
      dbtFinished = true;
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
      await exited;
      terminateDbt();
    }
  }, 60000);
});
