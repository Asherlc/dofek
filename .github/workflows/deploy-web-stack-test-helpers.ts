import {
  deployTestDigest,
  deployTestOldImage,
  deployTestRepository,
} from "../../scripts/deploy-image-test-helpers.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseEnv } from "node:util";
import { runInNewContext } from "node:vm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { parse, parseDocument } from "yaml";

export function runClickHouseReadinessFixture(
  runScript: string,
  change: "image" | "config" | "lifecycle" | "updating" | "no-op",
) {
  const dockerFixture = String.raw`
poll=0
sleep() { poll=$((poll + 1)); }
timeout() { shift; "$@"; }
docker() {
  case "$1 $2" in
    "service inspect")
      case "$5" in
        *TaskTemplate*)
          if [ "$FIXTURE_CLICKHOUSE_CHANGE" = "lifecycle" ]; then
            printf '{"ContainerSpec":{"Image":"requested","Configs":["current"],"StopGracePeriod":60000000000}}\n'
          else
            printf '{"Runtime":"container","RestartPolicy":{"Condition":"any","Delay":5000000000,"MaxAttempts":0},"ContainerSpec":{"StopGracePeriod":10000000000,"DNSConfig":{},"Image":"requested","Configs":["current"]}}\n'
          fi ;;
        *)
          if [ "$poll" -eq 0 ] && [ "$FIXTURE_CLICKHOUSE_CHANGE" = "updating" ]; then
            printf 'updating\n'
          else
            printf '\n'
          fi ;;
      esac ;;
    "service ps") printf '%s\n' 'running-task|Running 1 minute ago' ;;
    "inspect --type")
      if [ "$poll" -eq 0 ] && [ "$FIXTURE_CLICKHOUSE_CHANGE" = "image" ]; then
        printf '{"ContainerSpec":{"Image":"old","Configs":["current"]}}\n'
      elif [ "$poll" -eq 0 ] && [ "$FIXTURE_CLICKHOUSE_CHANGE" = "config" ]; then
        printf '{"ContainerSpec":{"Image":"requested","Configs":["old"]}}\n'
      elif [ "$poll" -ne 0 ] && [ "$FIXTURE_CLICKHOUSE_CHANGE" = "lifecycle" ]; then
        printf '{"ContainerSpec":{"Image":"requested","Configs":["current"],"StopGracePeriod":60000000000}}\n'
      else
        printf '{"ContainerSpec":{"Image":"requested","Configs":["current"]}}\n'
      fi ;;
    "run --rm") printf 'Ok.\n' ;;
    *) return 64 ;;
  esac
}
`;
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${dockerFixture}\n${runScript}`], {
    encoding: "utf8",
    env: { ...process.env, STACK_NAME: "dofek", FIXTURE_CLICKHOUSE_CHANGE: change },
  });
}

export async function runPipedashVerificationFixture(
  runScript: string,
  statuses: number[],
  password = "fixture-vault-password",
  rule = "Host(`pipedash.dofek.fit`)",
) {
  const script = runScript.split("<<'NODE'\n")[1]?.replace(/\nNODE\s*$/, "");
  if (!script) throw new Error("Missing executable Pipedash access verification");
  const [healthStatus, anonymousStatus, authenticatedStatus] = statuses;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const respond = (request: Request, status: number | undefined) => {
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    if (status === undefined) throw new Error(`Unexpected Pipedash request: ${request.url}`);
    return new HttpResponse(null, {
      status,
      ...(status === 302 ? { headers: { Location: new URL("/redirected", request.url).href } } : {}),
    });
  };
  const server = setupServer(
    ...["https://pipedash.dofek.fit", "https://actions.dofek.fit"].flatMap((base) => [
      http.get(`${base}/api/v1/health`, ({ request }) => respond(request, healthStatus)),
      http.get(`${base}/api/v1/providers`, ({ request }) =>
        respond(request, request.headers.has("authorization") ? authenticatedStatus : anonymousStatus),
      ),
      http.get(`${base}/redirected`, ({ request }) => respond(request, 200)),
    ]),
  );
  server.listen({ onUnhandledRequest: "error" });
  try {
    await runInNewContext(script, {
      require: (module: string) => {
        if (module === "yaml") return { parse };
        if (module === "node:util") return { parseEnv };
        if (module !== "node:fs") throw new Error(`Unexpected module: ${module}`);
        return {
          readFileSync: (path: string) => {
            if (path === "/fixture/pipedash.env") return `PIPEDASH_VAULT_PASSWORD=${password}\n`;
            if (path !== "deploy/docker-compose.yml") throw new Error(`Unexpected path: ${path}`);
            return JSON.stringify({
              services: {
                pipedash: { deploy: { labels: [`traefik.http.routers.pipedash.rule=${rule}`] } },
              },
            });
          },
        };
      },
      process: {
        env: {
          PIPEDASH_ENV_FILE: "/fixture/pipedash.env",
          PIPEDASH_URL: "https://pipedash.dofek.fit",
        },
      },
      fetch: globalThis.fetch,
    });
    return requests;
  } finally {
    server.close();
  }
}

export const requestedKafkaImage = `apache/kafka@sha256:${"c".repeat(64)}`;
export const currentKafkaImage = `apache/kafka:4.4.0@sha256:${"b".repeat(64)}`;

export function runPeerdbMigrationFixture(script: string, image: string, migrationStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-peerdb-migration-"));
  const trace = join(directory, "calls");
  const passwordFile = join(directory, "database.env");
  try {
    writeFileSync(trace, "");
    writeFileSync(passwordFile, "POSTGRES_PASSWORD=fixture-catalog-password\n", { mode: 0o600 });
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MIGRATION_TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'service' && args[1] === 'inspect') console.log(process.env.MIGRATION_IMAGE);
else if (args[0] === 'run') process.exit(Number(process.env.MIGRATION_STATUS));
else process.exit(65);
`);
    chmodSync(docker, 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${script}\nprintf 'CDC-PREPARE\\n'`], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, STACK_NAME: "fixture",
        DATABASE_OPERATIONS_ENV_FILE: passwordFile,
        MIGRATION_TRACE: trace, MIGRATION_IMAGE: image, MIGRATION_STATUS: String(migrationStatus),
      },
    });
    const calls = z.array(z.array(z.string())).parse(
      readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    );
    return { ...result, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

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
  service_name=""
  ls_format="replicas"
  for argument in "$@"; do
    case "$argument" in
      name=*) service_name="\${argument#name=}" ;;
      '{{.Name}} {{.Replicas}}') ls_format="name_replicas" ;;
      '{{.Name}}') ls_format="name" ;;
    esac
  done
  # Docker's service ls name filter matches a prefix, so dofek_web also
  # matches dofek_web-maintenance. Mirror that here so exact-name lookups are
  # exercised against the real collision.
  matching_services=()
  for scenario_file in "$SCENARIO_DIR"/*; do
    [ -f "$scenario_file" ] || continue
    candidate_service="\${scenario_file##*/}"
    case "$candidate_service" in
      "\$service_name"*) matching_services+=("\$candidate_service") ;;
    esac
  done
  if [ \${#matching_services[@]} -eq 0 ]; then
    matching_services=("\$service_name")
  fi
  for candidate_service in "\${matching_services[@]}"; do
    read_observation "\$candidate_service"
    case "\$ls_format" in
      name_replicas) printf '%s %s\\n' "\$candidate_service" "\$replicas" ;;
      name) printf '%s\\n' "\$candidate_service" ;;
      *) printf '%s\\n' "\$replicas" ;;
    esac
  done
  if [ "\${ADVANCE_ON_SERVICE_LS:-0}" = "1" ]; then
    read_observation "\$service_name"
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

export const workflowText = readFileSync(".github/workflows/deploy-web-stack.yml", "utf8");

export function deployConsumersRunScript(): string {
  const workflow = z.object({
    jobs: z.object({
      "web-stack": z.object({
        steps: z.array(z.object({ id: z.string().optional(), run: z.string().optional() })),
      }),
    }),
  }).parse(parse(workflowText));
  const script = workflow.jobs["web-stack"].steps.find((step) => step.id === "deploy_stack_full")?.run;
  if (!script) throw new Error("Could not find deploy_stack_full run script");
  return script;
}

export function workflowRunScript(name: string): string {
  const workflow = z.object({ jobs: z.object({ "web-stack": z.object({
    steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
  }) }) }).parse(parse(workflowText));
  const script = workflow.jobs["web-stack"].steps.find((step) => step.name === name)?.run;
  if (!script) throw new Error(`Could not find the workflow step: ${name}`);
  return script;
}

export function webStackSteps() {
  return z.object({ jobs: z.object({ "web-stack": z.object({
    steps: z.array(z.object({
      name: z.string().optional(),
      id: z.string().optional(),
      if: z.string().optional(),
      uses: z.string().optional(),
      with: z.record(z.unknown()).optional(),
      run: z.string().optional(),
    })),
  }) }) }).parse(parse(workflowText)).jobs["web-stack"].steps;
}

export function workflowStackServiceFilter(): string {
  return z.string().min(1).parse(parseDocument(workflowText).getIn(["jobs", "web-stack", "env", "STACK_SERVICE_FILTER"]));
}

export function deployedStackServices(stdout: string): unknown {
  const config = z.string().parse(stdout.match(/^STACK_CONFIG=(.+)$/m)?.[1]);
  return z.object({ services: z.unknown() }).parse(parse(z.string().parse(JSON.parse(config)))).services;
}

export function deployQuiescedRunScript(): string {
  const stepStart = workflowText.indexOf("      - name: Deploy stack without ClickHouse consumers");
  const runStart = workflowText.indexOf("        run: |\n", stepStart);
  const stepEnd = workflowText.indexOf("\n      - ", runStart);

  if (stepStart === -1 || runStart === -1 || stepEnd === -1) {
    throw new Error("Could not find the quiesced stack deploy step");
  }

  return workflowText
    .slice(runStart + "        run: |\n".length, stepEnd)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

export function runWorkflowDeployConsumers(scenarios: ConsumerScenarios, options: DeployConsumerOptions = {}) {
  return runDeployConsumers(deployConsumersRunScript(), scenarios, options);
}

export function runDeployQuiesced(
  processingReconciliation: readonly ServiceObservation[],
  options: DeployQuiescedOptions = {},
) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-deploy-quiesced-"));
  const scenarioDirectory = join(temporaryDirectory, "scenarios");
  const stateDirectory = join(temporaryDirectory, "state");
  const dockerPath = join(temporaryDirectory, "docker");
  const nodePath = join(temporaryDirectory, "node");
  const stackDeployCapturePath = join(temporaryDirectory, "stack-deploy-args");

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
    writeFileSync(pnpmPath, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(pnpmPath, 0o755);
    const defaultServiceNames = [
      "dofek_kafka",
      "dofek_web",
      "dofek_worker",
      "dofek_cdc-health",
      "dofek_analytics-worker",
      "dofek_metric-stream-clickhouse-sink",
      "dofek_metric-stream-live-clickhouse-sink",
      "dofek_metric-stream-history-clickhouse-sink",
      "dofek_metric-stream-r2-archive",
      "dofek_metric-stream-live-r2-archive",
      "dofek_metric-stream-history-r2-archive",
      "dofek_clickhouse",
      "dofek_databasus",
      "dofek_pipedash",
    ];
    for (const serviceName of defaultServiceNames) {
      writeFileSync(
        join(scenarioDirectory, serviceName),
        serializeScenario(options.serviceObservations?.[serviceName] ?? [STABLE_OBSERVATION]),
      );
    }
    writeFileSync(
      join(scenarioDirectory, "dofek_processing-reconciliation"),
      serializeScenario(processingReconciliation),
    );
    for (const [serviceName, observations] of Object.entries(options.serviceObservations ?? {})) {
      writeFileSync(join(scenarioDirectory, serviceName), serializeScenario(observations));
    }

    const shellScript = [
      `docker() (\n${MOCK_DOCKER}\n)`,
      "SECONDS=0",
      "simulated_seconds=0",
      'echo() { builtin echo "[${simulated_seconds}s] $*"; }',
      "sleep() { SECONDS=$((SECONDS + MOCK_SLEEP_SECONDS)); simulated_seconds=$((simulated_seconds + MOCK_SLEEP_SECONDS)); }",
      deployQuiescedRunScript(),
    ].join("\n");
    const githubOutputPath = join(temporaryDirectory, "github-output");
    const result = spawnSync("bash", ["-c", shellScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAIL_TASK_INSPECTION: options.failTaskInspection ? "1" : "0",
        APP_IMAGE: deployTestRepository + "@" + deployTestDigest,
        STACK_DEPLOY_STATUS: (options.stackDeployStatus ?? 0).toString(),
        MIGRATION_DEPLOYMENT_MODE: options.deploymentMode ?? "rolling",
        STACK_DEPLOY_CAPTURE: stackDeployCapturePath,
        ADVANCE_ON_SERVICE_LS: "1",
        MOCK_SLEEP_SECONDS: (options.sleepSeconds ?? 10).toString(),
        PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: temporaryDirectory,
        SCENARIO_DIR: scenarioDirectory,
        STACK_NAME: "dofek",
        STATE_DIR: stateDirectory,
        GITHUB_OUTPUT: githubOutputPath,
      },
    });

    return {
      ...result,
      githubOutput: readFileSync(githubOutputPath, "utf8"),
      stackDeployArgs: readFileSync(stackDeployCapturePath, "utf8"),
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function runPreMigrationWebConvergence(script: string) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-pre-migration-web-"));
  const scenarioDirectory = join(temporaryDirectory, "scenarios");
  const stateDirectory = join(temporaryDirectory, "state");
  try {
    mkdirSync(scenarioDirectory);
    mkdirSync(stateDirectory);
    writeFileSync(
      join(scenarioDirectory, "dofek_web"),
      serializeScenario([{ ...STABLE_OBSERVATION, replicas: "2/2", desiredReplicas: "2" }]),
    );
    writeFileSync(
      join(scenarioDirectory, "dofek_web-maintenance"),
      serializeScenario([{ ...STABLE_OBSERVATION, replicas: "0/0", desiredReplicas: "0" }]),
    );
    const shellScript = [
      `docker() (\n${MOCK_DOCKER}\n)`,
      "sleep() { echo 'Unexpected retry' >&2; return 97; }",
      "pnpm() { printf '%s\\n' \"$*\"; }",
      script,
    ].join("\n");
    return spawnSync("bash", ["-ec", shellScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        APP_IMAGE: deployTestRepository + "@" + deployTestDigest,
        STACK_NAME: "dofek",
        SCENARIO_DIR: scenarioDirectory,
        STATE_DIR: stateDirectory,
      },
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function runFlyDrainFixture(
  script: string,
  options: {
    states: readonly string[];
    listFails?: boolean;
    missingMachine?: boolean;
    wrongId?: boolean;
    stopFails?: boolean;
    sleepSeconds?: number;
  },
) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-fly-drain-"));
  const trace = join(directory, "calls.jsonl");
  const statesPath = join(directory, "states.json");
  const stateIndex = join(directory, "state-index");
  const machineId = "machine-fixture";
  const appName = "fixture-fly-sync";
  try {
    writeFileSync(trace, "");
    writeFileSync(statesPath, JSON.stringify(options.states));
    writeFileSync(stateIndex, "0");
    const flyctl = join(directory, "flyctl");
    writeFileSync(flyctl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FLY_TRACE, JSON.stringify(args) + "\\n");
if (args[0] === "machines" && args[1] === "list") {
  if (process.env.FLY_LIST_FAIL === "1") process.exit(2);
  const states = JSON.parse(fs.readFileSync(process.env.FLY_STATES, "utf8"));
  const index = Number(fs.readFileSync(process.env.FLY_STATE_INDEX, "utf8"));
  const state = states[Math.min(index, states.length - 1)];
  fs.writeFileSync(process.env.FLY_STATE_INDEX, String(index + 1));
  if (process.env.FLY_MISSING === "1") { console.log("[]"); process.exit(0); }
  const id = process.env.FLY_WRONG_ID === "1" ? "other-machine" : process.env.MACHINE_ID;
  console.log(JSON.stringify([{ id, state }])); process.exit(0);
}
if (args[0] === "machine" && args[1] === "stop") process.exit(process.env.FLY_STOP_FAIL === "1" ? 3 : 0);
process.exit(65);
`);
    chmodSync(flyctl, 0o755);
    const sleepSeconds = options.sleepSeconds ?? 5;
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c",
      `SECONDS=0\nsleep() { SECONDS=$((SECONDS + ${sleepSeconds})); }\n${script}\n`], {
      encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`,
        FLY_TRACE: trace, FLY_STATES: statesPath, FLY_STATE_INDEX: stateIndex,
        FLY_LIST_FAIL: options.listFails ? "1" : "0",
        FLY_MISSING: options.missingMachine ? "1" : "0",
        FLY_WRONG_ID: options.wrongId ? "1" : "0",
        FLY_STOP_FAIL: options.stopFails ? "1" : "0",
        FLY_SYNC_APP_NAME: appName, MACHINE_ID: machineId,
      },
    });
    const calls = z.array(z.array(z.string())).parse(
      readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    );
    return { ...result, calls, machineId, appName };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runWebEnvSelectionFixture(script: string) {
  return spawnSync("bash", ["-c", `node() {
  printf 'selected-web-env=%s image=%s\\n' "$WEB_ENV_FILE" "$APP_IMAGE"
  return 23
}
timeout() { shift; "$@"; }
${script}
`], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_IMAGE: deployTestRepository + "@" + deployTestDigest,
      MIGRATION_DEPLOYMENT_MODE: "rolling",
      WEB_ENV_FILE: "/synthetic/web.env",
      WEB_PRE_MIGRATION_ENV_FILE: "/synthetic/web-pre-migration.env",
      RUNNER_TEMP: "/synthetic",
      STACK_NAME: "dofek",
      STACK_FILE_FLAGS: "-c deploy/docker-compose.yml",
    },
  });
}

export function runPreMigrationWebLsFailureFixture(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "dofek-web-ls-failure-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "service" ] && [ "$2" = "inspect" ]; then printf 'completed\\n'; exit 0; fi
if [ "$1" = "service" ] && [ "$2" = "ls" ]; then printf 'mock docker service ls failure\\n' >&2; exit 42; fi
exit 64
`);
    chmodSync(join(bin, "docker"), 0o755);
    return spawnSync("timeout", ["5", "bash", "-e", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        APP_IMAGE: deployTestRepository + "@" + deployTestDigest,
        STACK_NAME: "dofek",
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runMigrationHistorySelectionFixture(script: string) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", `
pnpm() { printf '%s\\n' "$@"; }
${script}
`], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_IMAGE: `${deployTestRepository}@${deployTestDigest}`,
      PRE_MIGRATION_APP_IMAGE: deployTestOldImage,
      STACK_NAME: "dofek",
    },
  });
}
