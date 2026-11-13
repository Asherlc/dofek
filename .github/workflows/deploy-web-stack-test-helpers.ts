import { deployTestDigest, deployTestRepository } from "../../scripts/deploy-image-test-helpers.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseEnv } from "node:util";

export const requestedKafkaImage = `apache/kafka@sha256:${"c".repeat(64)}`;
export const currentKafkaImage = `apache/kafka:4.4.0@sha256:${"b".repeat(64)}`;

export function runKafkaImageFixture(
  script: string,
  brokerImage = requestedKafkaImage,
  probeImage = requestedKafkaImage,
) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-kafka-image-"));
  const output = join(directory, "environment");
  const trace = join(directory, "calls");
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true }));
    mkdirSync(join(directory, "deploy"));
    writeFileSync(
      join(directory, "deploy/docker-compose.yml"),
      `services:\n  kafka:\n    image: ${requestedKafkaImage}\n`,
    );
    symlinkSync(resolve("scripts"), join(directory, "scripts"));
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
    writeFileSync(output, "");
    writeFileSync(trace, "");
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KAFKA_TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'service' && args[1] === 'inspect') {
  console.log(args.at(-1).includes('ContainerSpec.Image') ? process.env.BROKER_IMAGE : 'completed');
} else if (args[0] === 'service' && args[1] === 'ls') console.log('1/1');
else if (args[0] !== 'run') process.exit(65);
`);
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_ENV: output,
        STACK_NAME: "fixture",
        BROKER_IMAGE: brokerImage,
        KAFKA_IMAGE: probeImage,
        KAFKA_TRACE: trace,
      },
    });
    const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean);
    return {
      ...result,
      environment: parseEnv(readFileSync(output, "utf8")),
      calls: z.array(z.array(z.string())).parse(calls.map(line => JSON.parse(line))),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
    for (const key of ["WEB_ENV_FILE", "WORKER_ENV_FILE", "METRIC_STREAM_R2_ARCHIVE_ENV_FILE", "METRIC_STREAM_LIVE_R2_ARCHIVE_ENV_FILE", "METRIC_STREAM_HISTORY_R2_ARCHIVE_ENV_FILE"]) {
      environment[key] = join(directory, "0.env");
    }
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.POLICY_TRACE, JSON.stringify(args) + '\\n');
if (args.includes('--list')) console.log(process.env.POLICY_TOPICS);
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
        KAFKA_IMAGE: requestedKafkaImage,
        POLICY_TRACE: trace,
        POLICY_FAIL: fail,
        POLICY_TOPICS: routes.flatMap(topic => [topic, `${topic}.quarantine.v1`]).join("\n"),
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

export function runKafkaInstallerFixture(script: string, failure: "checksum" | "install" | "" = "") {
  const directory = mkdtempSync(join(tmpdir(), "deploy-kafka-jmx-installer-"));
  const trace = join(directory, "calls.jsonl");
  const curl = join(directory, "curl");
  const sha256sum = join(directory, "sha256sum");
  const docker = join(directory, "docker");

  try {
    writeFileSync(curl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JMX_TRACE, JSON.stringify(['curl', ...args]) + '\\n');
const output = args[args.indexOf('--output') + 1];
fs.writeFileSync(output, 'fixture jar');
`);
    writeFileSync(sha256sum, `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.JMX_TRACE, JSON.stringify(['sha256sum', input]) + '\\n');
if (process.env.JMX_FAILURE === 'checksum') process.exit(1);
console.log(input.trim().split(/\\s+/)[0] + '  ' + input.trim().split(/\\s+/).at(-1) + ': OK');
`);
    writeFileSync(docker, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JMX_TRACE, JSON.stringify(['docker', ...args]) + '\\n');
const shellScriptIndex = args.indexOf('-euc') + 1;
const syntax = spawnSync('sh', ['-n', '-c', args[shellScriptIndex]], { encoding: 'utf8' });
if (syntax.status !== 0) { process.stderr.write(syntax.stderr); process.exit(syntax.status ?? 1); }
if (args[0] === 'run' && process.env.JMX_FAILURE === 'install') process.exit(42);
`);
    for (const executable of [curl, sha256sum, docker]) chmodSync(executable, 0o755);

    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        APP_IMAGE: `${deployTestRepository}@${deployTestDigest}`,
        RUNNER_TEMP: directory,
        JMX_TRACE: trace,
        JMX_FAILURE: failure,
      },
      timeout: 30_000,
    });
    const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => z.array(z.string()).parse(JSON.parse(line)));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface ServiceObservation {
  readonly desiredReplicas?: string;
  readonly image?: string;
  readonly replicas: string;
  readonly taskId: string;
  readonly updateState: string;
}

export interface ConsumerScenarios {
  readonly analyticsWorker: readonly ServiceObservation[];
  readonly metricStreamClickhouseSink: readonly ServiceObservation[];
  readonly processingReconciliation?: readonly ServiceObservation[];
}

export interface DeployConsumerOptions {
  readonly failTaskInspection?: boolean;
  readonly failOtaImageVerification?: boolean;
  readonly sleepSeconds?: number;
  readonly webConvergenceFailed?: boolean;
}

export interface DeployQuiescedOptions extends DeployConsumerOptions {
  readonly deploymentMode?: "rolling" | "maintenance";
  readonly serviceObservations?: Readonly<Record<string, readonly ServiceObservation[]>>;
  readonly stackDeployStatus?: number;
}



const otaImage = `${deployTestRepository}-ota@${deployTestDigest}`;

export const STABLE_OBSERVATION = {
  replicas: "1/1",
  taskId: "stable-task",
  updateState: "completed",
} satisfies ServiceObservation;

export function serializeScenario(observations: readonly ServiceObservation[]): string {
  return `${observations
    .map(
      ({
        desiredReplicas = "1",
        image = "ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        replicas,
        taskId,
        updateState,
      }) => `${updateState}|${replicas}|${taskId}|${image}|${desiredReplicas}`,
    )
    .join("\n")}\n`;
}


export function runDeployConsumers(script: string, scenarios: ConsumerScenarios, options: DeployConsumerOptions = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-deploy-consumers-"));
  const scenarioDirectory = join(temporaryDirectory, "scenarios");
  const stateDirectory = join(temporaryDirectory, "state");
  const dockerPath = join(temporaryDirectory, "docker");
  const nodePath = join(temporaryDirectory, "node");
  const stackDeployCapturePath = join(temporaryDirectory, "stack-deploy-args");
  const imageVerificationCapturePath = join(temporaryDirectory, "image-verification-args");

  try {
    mkdirSync(scenarioDirectory);
    mkdirSync(stateDirectory);
    writeFileSync(dockerPath, MOCK_DOCKER);
    writeFileSync(
      nodePath,
      "#!/usr/bin/env bash\nif [ \"$2\" = docker ] || [ \"$2\" = env ]; then shift; exec \"$@\"; fi\nexit 0\n",
    );
    chmodSync(dockerPath, 0o755);
    chmodSync(nodePath, 0o755);
    const pnpmPath = join(temporaryDirectory, "pnpm");
    writeFileSync(imageVerificationCapturePath, "");
    writeFileSync(pnpmPath, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = tsx ]
case "$2" in
  scripts/stack-service-image.ts) printf '%s\\n' "$MOCK_OTA_IMAGE" ;;
  scripts/verify-deploy-image.ts)
    printf '%s\\n' "$*" >> "$IMAGE_VERIFICATION_CAPTURE"
    if [ "$4" = dofek_ota ] && [ "$FAIL_OTA_IMAGE_VERIFICATION" = 1 ]; then
      printf '%s\\n' "OTA running image mismatch" >&2
      exit 1
    fi
    ;;
  *) exit 1 ;;
esac
`);
    writeFileSync(
      join(scenarioDirectory, "dofek_ota"),
      serializeScenario([{ ...STABLE_OBSERVATION, image: otaImage }]),
    );
    chmodSync(pnpmPath, 0o755);
    writeFileSync(
      join(scenarioDirectory, "dofek_analytics-worker"),
      serializeScenario(scenarios.analyticsWorker),
    );
    writeFileSync(
      join(scenarioDirectory, "dofek_metric-stream-clickhouse-sink"),
      serializeScenario(scenarios.metricStreamClickhouseSink),
    );
    writeFileSync(
      join(scenarioDirectory, "dofek_processing-reconciliation"),
      serializeScenario(scenarios.processingReconciliation ?? [STABLE_OBSERVATION]),
    );
    for (const serviceName of [
      "dofek_kafka",
      "dofek_metric-stream-live-clickhouse-sink",
      "dofek_metric-stream-history-clickhouse-sink",
      "dofek_metric-stream-r2-archive",
      "dofek_metric-stream-live-r2-archive",
      "dofek_metric-stream-history-r2-archive",
    ]) {
      writeFileSync(join(scenarioDirectory, serviceName), serializeScenario([STABLE_OBSERVATION]));
    }

    const result = spawnSync(
      "bash",
      [
        "-c",
        `docker() (
${MOCK_DOCKER}
)
SECONDS=0
simulated_seconds=0
echo() {
  builtin echo "[\${simulated_seconds}s] $*"
}
sleep() {
  SECONDS=$((SECONDS + MOCK_SLEEP_SECONDS))
  simulated_seconds=$((simulated_seconds + MOCK_SLEEP_SECONDS))
}
${script}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
          FAIL_TASK_INSPECTION: options.failTaskInspection ? "1" : "0",
          FAIL_OTA_IMAGE_VERIFICATION: options.failOtaImageVerification ? "1" : "0",
          MOCK_OTA_IMAGE: otaImage,
          IMAGE_VERIFICATION_CAPTURE: imageVerificationCapturePath,
          APP_IMAGE: deployTestRepository + "@" + deployTestDigest,
          MOCK_SLEEP_SECONDS: (options.sleepSeconds ?? 10).toString(),
          STACK_DEPLOY_CAPTURE: stackDeployCapturePath,
          WEB_CONVERGENCE_FAILED: options.webConvergenceFailed ? "true" : "false",
          RUNNER_TEMP: temporaryDirectory,
          SCENARIO_DIR: scenarioDirectory,
          STACK_FILE_FLAGS: "-c deploy/docker-compose.yml",
          STACK_NAME: "dofek",
          STATE_DIR: stateDirectory,
        },
      },
    );

    return {
      ...result,
      stackDeployArgs: readFileSync(stackDeployCapturePath, "utf8"),
      imageVerificationArgs: readFileSync(imageVerificationCapturePath, "utf8"),
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
