import { execFileSync } from "node:child_process";
import { z } from "zod";

const rcloneImage =
  "rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5";
const writers = ["deploy-web.yml", "deploy.yml", "mobile-preview-ota.yml", "cleanup-pr-r2.yml"];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePausedWriters(): void {
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  required("GH_TOKEN");
  for (const writer of writers) {
    const path = `repos/${repository}/actions/workflows/${writer}`;
    const workflow = z
      .object({ state: z.string() })
      .parse(JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" })));
    if (workflow.state !== "disabled_manually") {
      throw new Error(`${writer} must be disabled before OTA storage operations`);
    }
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = z.object({ total_count: z.number().int().nonnegative() }).parse(
        JSON.parse(
          execFileSync("gh", ["api", `${path}/runs?status=${status}&per_page=1`], {
            encoding: "utf8",
          }),
        ),
      );
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
    !["snapshot", "verify-snapshot", "rehearsal-copy", "restore-rehearsal"].includes(
      operation ?? "",
    )
  ) {
    throw new Error(
      "Usage: ota-storage.ts <snapshot|verify-snapshot|rehearsal-copy|restore-rehearsal> <snapshot ID>",
    );
  }
  const environment = {
    RCLONE_CONFIG_OTA_TYPE: "s3",
    RCLONE_CONFIG_OTA_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_OTA_REGION: "auto",
    RCLONE_CONFIG_OTA_ENDPOINT: required("R2_ENDPOINT"),
    RCLONE_CONFIG_OTA_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
    RCLONE_CONFIG_OTA_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
    RCLONE_CONFIG_OTA_NO_CHECK_BUCKET: "true",
  };
  requirePausedWriters();
  const run = (...arguments_: string[]): string =>
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        ...Object.keys(environment).flatMap((name) => ["--env", name]),
        rcloneImage,
        ...arguments_,
      ],
      { encoding: "utf8", env: { ...process.env, ...environment }, maxBuffer: 32 * 1024 * 1024 },
    );

  const snapshot = `ota:dofek-ota-backups/snapshots/${snapshotId}`;
  const rehearsal = `ota:dofek-ota-backups/rehearsals/${snapshotId}`;
  const productionSource = operation === "snapshot" || operation === "verify-snapshot";
  const source = productionSource ? "ota:dofek-ota" : snapshot;
  const destination = productionSource ? snapshot : rehearsal;
  const size = z
    .object({ count: z.number().int().nonnegative(), bytes: z.number().nonnegative() })
    .parse(JSON.parse(run("size", source, "--json")));
  if (size.count === 0) throw new Error("Source must contain objects before copy or restore");
  if (operation === "verify-snapshot") {
    run("check", source, destination, "--download");
    console.log(`Verified unchanged production: ${snapshotId}`);
    return;
  }
  if (operation !== "restore-rehearsal") {
    const objects = z
      .array(z.object({ Path: z.string() }))
      .parse(JSON.parse(run("lsjson", destination, "--recursive", "--files-only")));
    if (objects.length) throw new Error(`Destination ${destination} must be empty`);
    run("copy", source, destination, "--immutable");
  } else {
    // This destructive restore is restricted to the isolated rehearsal prefix.
    run("sync", source, destination);
  }
  run("check", source, destination, "--download");
  console.log(`Verified ${operation}: ${source} → ${destination}`);
}

await main();
