import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  readActivityIntegrityCadenceVersions,
  resolveActivityIntegrityCadenceScope,
  verifyActivityIntegrityCadenceBatch,
} from "./activity-data-integrity-cadence-scope.ts";
import type { ActivityIntegrityClickHouseClient } from "./activity-data-integrity-clickhouse.ts";
import type { ActivityIntegrityScopeInput } from "./activity-data-integrity-scope-policy.ts";
import { encodeActivityRefreshScope } from "./activity-refresh-scope.ts";

const UPSTREAM_MODELS = [
  "activity_source_records",
  "activity_duplicate_matches",
  "activity_duplicate_groups",
  "deduped_activities",
  "deduped_activity_members",
  "activity_effort_identity",
  "activity_sensor_sample",
  "activity_location_sample",
  "activity_route_identity",
] as const;
const DOWNSTREAM_MODELS = [
  "activity_sensor_summary_rows",
  "activity_location_summary_rows",
  "activity_stream_points",
  "activity_summary_rows",
  "activity_vo2max_estimate",
] as const;
const CADENCE_BATCH_SIZE = 100;

export interface ActivityIntegrityDbtBuildInput extends ActivityIntegrityScopeInput {
  eventTimeStart: Date;
  eventTimeEnd: Date;
}

export async function runActivityIntegrityDbtBuild(
  input: ActivityIntegrityDbtBuildInput,
  clickHouse: ActivityIntegrityClickHouseClient,
): Promise<void> {
  if (!(input.eventTimeStart < input.eventTimeEnd)) {
    throw new Error("activity integrity dbt build requires valid increasing event-time bounds");
  }
  const before = await resolveActivityIntegrityCadenceScope(clickHouse, input);
  const project = await mkdtemp(join(tmpdir(), "activity-integrity-dbt-"));
  try {
    const config = await prepareRuntimeProject(project);
    const build = async (
      activityIds: readonly string[],
      models: readonly string[],
      cadenceIds?: readonly string[],
    ) => {
      await writeFile(
        join(project, "dbt_project.yml"),
        stringify(
          {
            ...config,
            vars: {
              ...z.record(z.string(), z.unknown()).parse(config.vars ?? {}),
              activity_refresh_user_id: input.userId,
              activity_refresh_activity_ids_base64: encodeActivityRefreshScope(activityIds),
              activity_sensor_sample_begin: input.eventTimeStart.toISOString().slice(0, 10),
              ...(cadenceIds === undefined
                ? {}
                : { activity_step_cadence_repair_activity_ids: cadenceIds }),
            },
          },
          { defaultStringType: "QUOTE_DOUBLE" },
        ),
        { mode: 0o600 },
      );
      await runDbtPhase(input, project, models);
    };
    // Retain old aliases before upstream can replace their member mappings.
    await build(before.activityIds, UPSTREAM_MODELS);
    const final = await resolveActivityIntegrityCadenceScope(clickHouse, {
      userId: input.userId,
      activityIds: before.activityIds,
    });
    // Freeze K once. Empty K still creates the initial target using exact [].
    for (
      let offset = 0;
      offset < Math.max(1, final.cadenceActivityIds.length);
      offset += CADENCE_BATCH_SIZE
    ) {
      const batch = final.cadenceActivityIds.slice(offset, offset + CADENCE_BATCH_SIZE);
      const scope = { userId: input.userId, activityIds: batch };
      const versions = await readActivityIntegrityCadenceVersions(clickHouse, scope);
      await build(final.activityIds, ["activity_step_cadence_rows"], batch);
      await verifyActivityIntegrityCadenceBatch(clickHouse, scope, versions);
    }
    await build(final.activityIds, DOWNSTREAM_MODELS);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function prepareRuntimeProject(project: string): Promise<Record<string, unknown>> {
  const original = resolve("analytics");
  const config = z
    .record(z.string(), z.unknown())
    .parse(parse(await readFile(join(original, "dbt_project.yml"), "utf8")));
  for (const [key, defaults] of Object.entries({
    "model-paths": ["models"],
    "macro-paths": ["macros"],
    "test-paths": ["tests"],
    "analysis-paths": ["analyses"],
    "seed-paths": ["seeds"],
    "snapshot-paths": ["snapshots"],
  })) {
    const paths = z.array(z.string()).parse(config[key] ?? defaults);
    config[key] = await Promise.all(
      paths.map(async (path, index) => {
        const isolated = `${key}-${index}`;
        await symlink(resolve(original, path), join(project, isolated), "dir");
        return isolated;
      }),
    );
  }
  const dependencies = z.string().parse(config["packages-install-path"] ?? "dbt_packages");
  await symlink(resolve(original, dependencies), join(project, "dbt_packages"), "dir");
  config["packages-install-path"] = "dbt_packages";
  config["target-path"] = "target";
  return config;
}

async function runDbtPhase(
  input: ActivityIntegrityDbtBuildInput,
  project: string,
  models: readonly string[],
): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        "analytics",
        "dbt",
        "build",
        "--project-dir",
        project,
        "--profiles-dir",
        "analytics",
        "--threads",
        "1",
        "--event-time-start",
        input.eventTimeStart.toISOString().slice(0, 19),
        "--event-time-end",
        input.eventTimeEnd.toISOString().slice(0, 19),
        "--select",
        models.join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DBT_TARGET: process.env.DBT_TARGET ?? "dev",
          UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? "../.venv-analytics",
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0)
    throw new Error(`bounded activity integrity dbt build failed with exit code ${exitCode}`);
}
