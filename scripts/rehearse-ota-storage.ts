import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function awaitReady(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follower = spawn("docker", ["logs", "--follow", name]);
    const marker = "Server is ready to serve traffic.";
    let tail = "";
    let ready = false;
    const observe = (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail += chunk.toString();
      if (!ready && tail.includes(marker)) {
        ready = true;
        follower.kill();
        resolve();
      }
      tail = tail.slice(-marker.length);
    };
    follower.stdout?.on("data", observe);
    follower.stderr?.on("data", observe);
    follower.once("error", reject);
    follower.once("exit", (code) => {
      if (!ready)
        reject(new Error(`Candidate exited before migration readiness (docker logs exit ${code})`));
    });
  });
}

async function main(): Promise<void> {
  const [snapshotId, ...extra] = process.argv.slice(2);
  const image = required("OTA_REHEARSAL_IMAGE");
  const repository = required("GITHUB_REPOSITORY").toLowerCase();
  const prefix = `ghcr.io/${repository}-ota-internal@sha256:`;
  if (!image.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))) {
    throw new Error(
      "OTA_REHEARSAL_IMAGE must be an immutable digest in this repository's private OTA package",
    );
  }
  if (!snapshotId || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(snapshotId) || extra.length)
    throw new Error("A valid snapshot ID is required");
  const name = `dofek-ota-rehearsal-${required("GITHUB_RUN_ID")}-${required("GITHUB_RUN_ATTEMPT")}`;
  const baseUrl = "http://127.0.0.1:3210";
  const environment = {
    EXPO_APP_ID: required("EXPO_APP_ID"),
    EXPO_ACCESS_TOKEN: required("EXPO_TOKEN"),
    PRIVATE_EXPO_KEY_B64: required("OTA_PRIVATE_KEY_B64"),
    PUBLIC_EXPO_KEY_B64: required("OTA_PUBLIC_KEY_B64"),
    KEYS_STORAGE_TYPE: "environment",
    JWT_SECRET: required("OTA_JWT_SECRET"),
    STORAGE_MODE: "s3",
    S3_BUCKET_NAME: "dofek-ota-backups",
    BUCKET_KEY_PREFIX: `rehearsals/${snapshotId}/`,
    AWS_REGION: "auto",
    AWS_BASE_ENDPOINT: required("R2_ENDPOINT"),
    AWS_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
    BASE_URL: baseUrl,
    PORT: "3000",
    CACHE_MODE: "local",
  };
  const storage = (operation: string, confirmedStopped = false) =>
    execFileSync("pnpm", ["tsx", "scripts/ota-storage.ts", operation, snapshotId], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, OTA_REHEARSAL_STOPPED: String(confirmedStopped) },
    });
  storage("verify-snapshot");
  storage("verify-rehearsal");
  let stopped = false;
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--pull=always",
        "--name",
        name,
        "--publish",
        "127.0.0.1:3210:3000",
        ...Object.keys(environment).flatMap((key) => ["--env", key]),
        image,
      ],
      { encoding: "utf8", env: { ...process.env, ...environment } },
    );
    await awaitReady(name);
    const update = z
      .object({ id: z.string().min(1), runtimeVersion: z.string().min(1) })
      .parse(JSON.parse(storage("verify-migration")));
    const certificate = readFileSync("packages/mobile/certs/certificate.pem", "utf8");
    for (const url of ["https://ota.dofek.asherlc.com/manifest", `${baseUrl}/manifest`]) {
      await verifyOtaUpdate({
        ...update,
        expectedId: update.id,
        url,
        channel: "production",
        certificate,
        fetchImplementation: fetch,
      });
    }
    console.log(
      `Verified retained update ${update.id}, runtime ${update.runtimeVersion}, device signature and asset bytes`,
    );
  } finally {
    for (const operation of ["stop", "rm"]) {
      const result = spawnSync("docker", [operation, name], { stdio: "inherit" });
      if (operation === "stop") stopped = result.status === 0;
      if (result.status !== 0) {
        console.error(`Rehearsal container ${operation} failed (exit ${result.status})`);
        process.exitCode = 1;
      }
    }
  }
  if (!stopped) throw new Error("Cannot quiesce rehearsal candidate; storage restore refused");
  storage("restore-rehearsal", true);
  storage("verify-snapshot");
  console.log(`Migration and byte-verified restore rehearsal passed for ${image}`);
}

await main();
