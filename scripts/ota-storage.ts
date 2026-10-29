import { execFileSync } from "node:child_process";
import { z } from "zod";
import { OtaMigrationLayout } from "./ota-migration-layout.ts";

const rcloneImage =
  "rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5";
const writers = ["deploy-web.yml", "deploy.yml", "mobile-preview-ota.yml", "cleanup-pr-r2.yml"];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function requirePausedWriters(): Promise<void> {
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  const token = required("GH_TOKEN");
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new Error(`Cannot verify paused OTA writers: GitHub returned HTTP ${response.status}`);
    return response.json();
  };
  for (const writer of writers) {
    const path = `repos/${repository}/actions/workflows/${writer}`;
    const workflow = z.object({ state: z.string() }).parse(await get(path));
    if (workflow.state !== "disabled_manually") {
      throw new Error(`${writer} must be disabled before OTA storage operations`);
    }
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = z
        .object({ total_count: z.number().int().nonnegative() })
        .parse(await get(`${path}/runs?status=${status}&per_page=1`));
      if (runs.total_count > 0) throw new Error(`${writer} still has ${status} runs`);
    }
  }
}

async function main(): Promise<void> {
  const [operation, snapshotId, ...extra] = process.argv.slice(2);
  if (!snapshotId || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(snapshotId)) {
    throw new Error("A snapshot ID of 8–64 lowercase letters, digits or hyphens is required");
  }
  if (
    extra.length ||
    ![
      "snapshot",
      "verify-snapshot",
      "verify-rehearsal",
      "verify-migration",
      "rehearsal-copy",
      "restore-rehearsal",
    ].includes(operation ?? "")
  ) {
    throw new Error(
      "Usage: ota-storage.ts <snapshot|verify-snapshot|rehearsal-copy|restore-rehearsal> <snapshot ID>",
    );
  }
  if (operation === "restore-rehearsal" && process.env.OTA_REHEARSAL_STOPPED !== "true")
    throw new Error("Confirm the rehearsal candidate has stopped before restoring its copy");
  const environment = {
    RCLONE_CONFIG_OTA_TYPE: "s3",
    RCLONE_CONFIG_OTA_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_OTA_REGION: "auto",
    RCLONE_CONFIG_OTA_ENDPOINT: required("R2_ENDPOINT"),
    RCLONE_CONFIG_OTA_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
    RCLONE_CONFIG_OTA_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
    RCLONE_CONFIG_OTA_NO_CHECK_BUCKET: "true",
  };
  await requirePausedWriters();
  const run = (arguments_: string[], input?: string): string => {
    const started = Date.now();
    console.error(`OTA storage: starting ${arguments_[0]}`);
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--interactive",
        ...Object.keys(environment).flatMap((name) => ["--env", name]),
        rcloneImage,
        "--stats",
        "30s",
        "--stats-one-line",
        "--stats-log-level",
        "NOTICE",
        ...arguments_,
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
        input,
        env: { ...process.env, ...environment },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    console.error(`OTA storage: completed ${arguments_[0]} in ${Date.now() - started}ms`);
    return output;
  };

  const snapshot = `ota:dofek-ota-backups/snapshots/${snapshotId}`;
  const rehearsal = `ota:dofek-ota-backups/rehearsals/${snapshotId}`;
  const productionSource = operation === "snapshot" || operation === "verify-snapshot";
  const source = productionSource ? "ota:dofek-ota" : snapshot;
  const destination = productionSource ? snapshot : rehearsal;
  const size = z
    .object({ count: z.number().int().nonnegative(), bytes: z.number().nonnegative() })
    .parse(JSON.parse(run(["size", source, "--json"])));
  if (size.count === 0) throw new Error("Source must contain objects before copy or restore");
  if (operation === "verify-snapshot" || operation === "verify-rehearsal") {
    run(["check", source, destination, "--download"]);
    console.log(`Verified ${operation}: ${snapshotId}`);
    return;
  }
  if (operation === "verify-migration") {
    const appId = required("EXPO_APP_ID");
    const listPaths = (remote: string) =>
      z
        .array(z.object({ Path: z.string() }))
        .parse(JSON.parse(run(["lsjson", remote, "--recursive", "--files-only"])))
        .map((object) => object.Path);
    const originalPaths = listPaths(snapshot);
    const layout = new OtaMigrationLayout(originalPaths, appId);
    layout.assertMigratedPaths(listPaths(rehearsal));
    for (const [paths, target] of [
      [layout.movedPaths, `${rehearsal}/${appId}`],
      [layout.unchangedPaths, rehearsal],
    ] as const) {
      if (paths.length)
        run(
          ["check", snapshot, target, "--download", "--files-from0", "-"],
          `${paths.join("\0")}\0`,
        );
    }
    const complete = new Set(originalPaths);
    const metadataPaths = originalPaths
      .filter(
        (path) =>
          /^main\/[^/]+\/\d+\/update-metadata\.json$/.test(path) &&
          complete.has(path.replace(/update-metadata\.json$/, ".check")),
      )
      .sort((left, right) => Number(right.split("/")[2]) - Number(left.split("/")[2]));
    for (const path of metadataPaths) {
      const metadata = z
        .object({ platform: z.enum(["ios", "android"]), updateUUID: z.string().min(1) })
        .parse(JSON.parse(run(["cat", `${snapshot}/${path}`])));
      if (metadata.platform === "ios") {
        console.log(
          JSON.stringify({
            id: metadata.updateUUID,
            runtimeVersion: z.string().min(1).parse(path.split("/")[1]),
          }),
        );
        return;
      }
    }
    throw new Error("Snapshot has no complete main iOS update to audit");
  }
  if (operation !== "restore-rehearsal") {
    const objects = z
      .array(z.object({ Path: z.string() }))
      .parse(JSON.parse(run(["lsjson", destination, "--recursive", "--files-only"])));
    if (objects.length) throw new Error(`Destination ${destination} must be empty`);
    run(["copy", source, destination, "--immutable"]);
  } else {
    // This destructive restore is restricted to the isolated rehearsal prefix.
    run(["sync", source, destination]);
  }
  run(["check", source, destination, "--download"]);
  console.log(`Verified ${operation}: ${source} → ${destination}`);
}

await main();
