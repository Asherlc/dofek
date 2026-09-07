import { spawn } from "node:child_process";

const ACTIVITY_INTEGRITY_DBT_MODELS = [
  "activity_source_records",
  "activity_duplicate_matches",
  "activity_duplicate_groups",
  "deduped_activities",
  "deduped_activity_members",
  "activity_sensor_sample",
  "activity_sensor_summary_rows",
  "activity_summary_rows",
] as const;

export async function runActivityIntegrityDbtBuild(input: {
  userId: string;
  activityIds: readonly string[];
}): Promise<void> {
  const variables = {
    activity_refresh_user_id: input.userId,
    activity_refresh_activity_ids: input.activityIds,
  };
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
        "analytics",
        "--profiles-dir",
        "analytics",
        "--threads",
        "1",
        "--vars",
        JSON.stringify(variables),
        "--select",
        ACTIVITY_INTEGRITY_DBT_MODELS.join(" "),
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
  if (exitCode !== 0) {
    throw new Error(`bounded activity integrity dbt build failed with exit code ${exitCode}`);
  }
}
