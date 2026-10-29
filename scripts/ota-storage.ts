import { execFileSync } from "node:child_process";
import { z } from "zod";
import { OtaMigrationLayout } from "./ota-migration-layout.ts";
import { assertServiceStopped } from "./wait-migration-quiescence.ts";

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
      "inventory",
      "snapshot",
      "verify-snapshot",
      "verify-rehearsal",
      "verify-migration",
      "verify-production-migration",
      "rehearsal-copy",
      "restore-rehearsal",
      "restore-production",
    ].includes(operation ?? "")
  ) {
    throw new Error(
      "Usage: ota-storage.ts <inventory|snapshot|verify-snapshot|verify-rehearsal|verify-migration|verify-production-migration|rehearsal-copy|restore-rehearsal|restore-production> <snapshot ID>",
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
  const snapshotRunId =
    operation === "snapshot"
      ? z.string().regex(/^\d+$/).parse(required("GITHUB_RUN_ID"))
      : undefined;
  await requirePausedWriters();
  if (operation === "restore-production") {
    const context = required("OTA_DOCKER_CONTEXT");
    const expectedHost = `ssh://ubuntu@${required("ORACLE_SERVER_HOST")}`;
    const endpoints = z
      .array(z.object({ Endpoints: z.object({ docker: z.object({ Host: z.string() }) }) }))
      .length(1)
      .parse(
        JSON.parse(execFileSync("docker", ["context", "inspect", context], { encoding: "utf8" })),
      );
    if (endpoints[0]?.Endpoints.docker.Host !== expectedHost)
      throw new Error("OTA restore requires the production Docker endpoint");
    assertServiceStopped("dofek_ota", context);
  }
  const run = (arguments_: string[], input?: string): string => {
    const started = Date.now();
    console.error(`OTA storage: starting ${arguments_[0]}`);
    try {
      return execFileSync(
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
    } finally {
      console.error(`OTA storage: finished ${arguments_[0]} in ${Date.now() - started}ms`);
    }
  };

  const snapshot = `ota:dofek-ota-backups/snapshots/${snapshotId}`;
  const receiptPath = `${snapshot}.verified.json`;
  const rehearsal = `ota:dofek-ota-backups/rehearsals/${snapshotId}`;
  const productionSource =
    operation === "inventory" || operation === "snapshot" || operation === "verify-snapshot";
  const source = productionSource ? "ota:dofek-ota" : snapshot;
  const destination =
    operation === "restore-production" ? "ota:dofek-ota" : productionSource ? snapshot : rehearsal;
  const size = z
    .object({ count: z.number().int().nonnegative(), bytes: z.number().nonnegative() })
    .parse(JSON.parse(run(["size", source, "--json"])));
  console.error(`OTA storage: source ${source} has ${size.count} objects, ${size.bytes} bytes`);
  if (operation === "inventory") {
    console.log(JSON.stringify({ source, ...size }));
    return;
  }
  if (size.count === 0) throw new Error("Source must contain objects before copy or restore");
  if (operation === "restore-production" || operation === "verify-production-migration") {
    const receipt = z
      .object({
        version: z.literal(1),
        snapshotId: z.literal(snapshotId),
        count: z.number().int().positive(),
        bytes: z.number().nonnegative(),
        runId: z.string().regex(/^\d+$/),
      })
      .parse(JSON.parse(run(["cat", receiptPath])));
    if (receipt.count !== size.count || receipt.bytes !== size.bytes)
      throw new Error("Snapshot differs from its verified backup receipt");
  }
  if (operation === "verify-snapshot" || operation === "verify-rehearsal") {
    run(["check", source, destination, "--download"]);
    console.log(`Verified ${operation}: ${snapshotId}`);
    return;
  }
  if (operation === "verify-migration" || operation === "verify-production-migration") {
    const migrated = operation === "verify-production-migration" ? "ota:dofek-ota" : rehearsal;
    const appId = required("EXPO_APP_ID");
    const listPaths = (remote: string) =>
      z
        .array(z.object({ Path: z.string() }))
        .parse(JSON.parse(run(["lsjson", remote, "--recursive", "--files-only"])))
        .map((object) => object.Path);
    const originalPaths = listPaths(snapshot);
    const layout = new OtaMigrationLayout(originalPaths, appId);
    layout.assertMigratedPaths(listPaths(migrated));
    for (const [paths, target] of [
      [layout.movedPaths, `${migrated}/${appId}`],
      [layout.unchangedPaths, migrated],
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
  if (operation !== "restore-rehearsal" && operation !== "restore-production") {
    const objects = z
      .array(z.object({ Path: z.string() }))
      .parse(JSON.parse(run(["lsjson", destination, "--recursive", "--files-only"])));
    if (objects.length) throw new Error(`Destination ${destination} must be empty`);
    run(["copy", source, destination, "--immutable"]);
  } else {
    run(["sync", source, destination]);
  }
  run(["check", source, destination, "--download"]);
  if (operation === "snapshot") {
    run(
      ["rcat", receiptPath, "--immutable"],
      JSON.stringify({ version: 1, snapshotId, ...size, runId: snapshotRunId }),
    );
  }
  console.log(`Verified ${operation}: ${source} → ${destination}`);
}

await main();
