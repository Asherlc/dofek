import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export function runKafkaBackendFixture(script: string, drift = "") {
  const directory = mkdtempSync(join(tmpdir(), "deploy-kafka-backend-"));
  try {
    const worker = {
      KAFKA_CLUSTER_ID: "0000000000000000000000",
      KAFKA_TIERED_STORAGE_BUCKET: "fixture-bucket",
      KAFKA_TIERED_STORAGE_ENDPOINT: "https://fixture.r2.cloudflarestorage.com",
      KAFKA_TIERED_STORAGE_REGION: "auto",
      KAFKA_TIERED_STORAGE_ACCESS_KEY_ID: "fixture-key",
      KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY: "fixture-secret",
    };
    const properties = {
      "rsm.config.storage.backend.class": "io.aiven.kafka.tieredstorage.storage.s3.S3Storage",
      "rsm.config.storage.s3.bucket.name": drift === "bucket" ? "wrong-bucket" : worker.KAFKA_TIERED_STORAGE_BUCKET,
      "rsm.config.storage.s3.endpoint.url": worker.KAFKA_TIERED_STORAGE_ENDPOINT,
      "rsm.config.storage.s3.region": worker.KAFKA_TIERED_STORAGE_REGION,
      "rsm.config.key.prefix": drift === "prefix" ? "wrong-prefix/" : `${worker.KAFKA_CLUSTER_ID}/`,
    };
    const workerFile = join(directory, "worker.env");
    writeFileSync(workerFile, Object.entries(worker).map(([key, value]) => `${key}=${value}`).join("\n"));
    writeFileSync(join(directory, "properties"), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n"));
    writeFileSync(join(directory, "worker.json"), JSON.stringify(Object.entries({ ...worker, ...(drift === "worker" ? { KAFKA_TIERED_STORAGE_BUCKET: "wrong-worker" } : {}) }).map(([key, value]) => `${key}=${value}`)));
    writeFileSync(join(directory, "broker.json"), JSON.stringify([
      `CLUSTER_ID=${worker.KAFKA_CLUSTER_ID}`,
      `AWS_ACCESS_KEY_ID=${worker.KAFKA_TIERED_STORAGE_ACCESS_KEY_ID}`,
      `AWS_SECRET_ACCESS_KEY=${drift === "credential" ? "wrong-secret" : worker.KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY}`,
    ]));
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'service' && args[1] === 'ps') console.log('task-id');
else if (args[0] === 'service' && args[1] === 'inspect') process.stdout.write(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, 'worker.json')));
else if (args[0] === 'inspect' && args.includes('task-id')) console.log('container-id');
else if (args[0] === 'inspect') process.stdout.write(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, 'broker.json')));
else if (args[0] === 'cp') fs.copyFileSync(path.join(process.env.FIXTURE_ROOT, 'properties'), args[2]);
else process.exit(65);
`);
    chmodSync(docker, 0o755);
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_ROOT: directory, RUNNER_TEMP: directory, WORKER_ENV_FILE: workerFile, STACK_NAME: "fixture" },
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function runTopicPolicyFixture(script: string, fail: "alter" | "verify" | "" = "", routes: readonly string[] = ["source", "live", "history"]) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-topic-policy-"));
  const trace = join(directory, "docker-calls.jsonl");
  const policyDirectory = join(directory, "deploy/kafka");
  const environment: Record<string, string> = {};
  try {
    mkdirSync(policyDirectory, { recursive: true });
    copyFileSync(resolve("deploy/kafka/topic-policy.json"), join(policyDirectory, "topic-policy.json"));
    for (const [index, key] of [
      "METRIC_STREAM_CLICKHOUSE_SINK_ENV_FILE",
      "METRIC_STREAM_LIVE_CLICKHOUSE_SINK_ENV_FILE",
      "METRIC_STREAM_HISTORY_CLICKHOUSE_SINK_ENV_FILE",
    ].entries()) {
      const topic = routes[index];
      if (topic === undefined) throw new Error("invalid fixture route");
      const path = join(directory, `${index}.env`);
      writeFileSync(path, `REDPANDA_BROKERS=kafka:9092\nMETRIC_STREAM_TOPIC=${topic}\n`);
      environment[key] = path;
    }
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.POLICY_TRACE, JSON.stringify(args) + '\\n');
if (args.includes('--alter') && process.env.POLICY_FAIL === 'alter') {
  console.error('native incremental alter rejected'); process.exit(64);
}
if (args.includes('node') && process.env.POLICY_FAIL === 'verify') {
  console.error('broker readback differs'); process.exit(65);
}
if (args.includes('-i')) process.stdin.resume();
`);
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${script}\nprintf 'RESTORE-CONSUMERS\\n'`], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment,
        PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        STACK_NAME: "fixture",
        APP_IMAGE: "ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        POLICY_TRACE: trace,
        POLICY_FAIL: fail,
      },
      timeout: 30_000,
    });
    const calls = z.array(z.array(z.string())).parse(
      (existsSync(trace) ? readFileSync(trace, "utf8") : "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    );
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const MOCK_DOCKER = `#!/usr/bin/env bash
set -euo pipefail

read_observation() {
  local observed_service_name="$1"
  local candidate_observation
  local last_observation=""
  local line_number=0
  local target_line

  scenario_file="$SCENARIO_DIR/$observed_service_name"
  state_file="$STATE_DIR/$observed_service_name"
  observation_index=0
  observation=""

  if [ -f "$state_file" ]; then
    observation_index="$(<"$state_file")"
  fi
  target_line=$((observation_index + 1))
  while IFS= read -r candidate_observation; do
    line_number=$((line_number + 1))
    last_observation="$candidate_observation"
    if [ "$line_number" -eq "$target_line" ]; then
      observation="$candidate_observation"
      break
    fi
  done < "$scenario_file"
  if [ -z "$observation" ]; then
    observation="$last_observation"
  fi
  IFS='|' read -r update_state replicas task_id image desired_replicas <<< "$observation"
}

if [ "$1" = "stack" ] && [ "$2" = "deploy" ]; then
  printf '%s\\n' "$@" > "$STACK_DEPLOY_CAPTURE"
  exit "\${STACK_DEPLOY_STATUS:-0}"
fi

if [ "$1" = "stack" ] && [ "$2" = "config" ]; then
  exit 0
fi

if [ "$1" = "service" ] && [ "$2" = "inspect" ]; then
  service_name="$3"
  format="$5"
  read_observation "$service_name"
  case "$format" in
    *UpdateStatus*) printf '%s\\n' "$update_state" ;;
    *ContainerSpec.Image*) printf '%s\\n' "$image" ;;
    *Mode.Replicated.Replicas*) printf '%s\\n' "$desired_replicas" ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$1" = "service" ] && [ "$2" = "ls" ]; then
  for argument in "$@"; do
    case "$argument" in
      name=*) service_name="\${argument#name=}" ;;
    esac
  done
  read_observation "$service_name"
  printf '%s\\n' "$replicas"
  if [ "\${ADVANCE_ON_SERVICE_LS:-0}" = "1" ]; then
    printf '%s\\n' "$((observation_index + 1))" > "$state_file"
  fi
  exit 0
fi

if [ "$1" = "service" ] && [ "$2" = "ps" ]; then
  service_name="$3"
  case " $* " in
    *" --format "*)
      if [ "$FAIL_TASK_INSPECTION" = "1" ]; then
        printf '%s\\n' "mock task inspection failed" >&2
        exit 64
      fi
      read_observation "$service_name"
      printf '%s\\n' "$task_id"
      printf '%s\\n' "$((observation_index + 1))" > "$state_file"
      ;;
    *) printf '%s\\n' "diagnostic task output for $service_name" ;;
  esac
  exit 0
fi

exit 1
`;
