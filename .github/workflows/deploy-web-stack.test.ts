import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowText = readFileSync(".github/workflows/deploy-web-stack.yml", "utf8");

interface ServiceObservation {
  readonly replicas: string;
  readonly taskId: string;
  readonly updateState: string;
}

interface ConsumerScenarios {
  readonly analyticsWorker: readonly ServiceObservation[];
  readonly metricStreamClickhouseSink: readonly ServiceObservation[];
  readonly processingReconciliation?: readonly ServiceObservation[];
}

interface DeployConsumerOptions {
  readonly failTaskInspection?: boolean;
  readonly sleepSeconds?: number;
}

const MOCK_DOCKER = `#!/usr/bin/env bash
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
  IFS='|' read -r update_state replicas task_id <<< "$observation"
}

if [ "$1" = "stack" ] && [ "$2" = "deploy" ]; then
  exit 0
fi

if [ "$1" = "service" ] && [ "$2" = "inspect" ]; then
  service_name="$3"
  format="$5"
  read_observation "$service_name"
  case "$format" in
    *UpdateStatus*) printf '%s\\n' "$update_state" ;;
    *ContainerSpec.Image*) printf '%s\\n' "ghcr.io/asherlc/dofek:test" ;;
    *Mode.Replicated.Replicas*) printf '%s\\n' "1" ;;
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

function deployConsumersRunScript(): string {
  const stepStart = workflowText.indexOf("      - name: Deploy ClickHouse consumer services");
  const runStart = workflowText.indexOf("        run: |\n", stepStart);
  const stepEnd = workflowText.indexOf("\n      - ", runStart);

  if (stepStart === -1 || runStart === -1 || stepEnd === -1) {
    throw new Error("Could not find the ClickHouse consumer deploy step");
  }

  return workflowText
    .slice(runStart + "        run: |\n".length, stepEnd)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function serializeScenario(observations: readonly ServiceObservation[]): string {
  return `${observations
    .map(({ replicas, taskId, updateState }) => `${updateState}|${replicas}|${taskId}`)
    .join("\n")}\n`;
}

function runDeployConsumers(scenarios: ConsumerScenarios, options: DeployConsumerOptions = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-deploy-consumers-"));
  const scenarioDirectory = join(temporaryDirectory, "scenarios");
  const stateDirectory = join(temporaryDirectory, "state");
  const dockerPath = join(temporaryDirectory, "docker");
  const nodePath = join(temporaryDirectory, "node");

  try {
    mkdirSync(scenarioDirectory);
    mkdirSync(stateDirectory);
    writeFileSync(dockerPath, MOCK_DOCKER);
    writeFileSync(nodePath, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(dockerPath, 0o755);
    chmodSync(nodePath, 0o755);
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

    const result = spawnSync(
      "bash",
      [
        "-c",
        `SECONDS=0
simulated_seconds=0
echo() {
  builtin echo "[\${simulated_seconds}s] $*"
}
sleep() {
  SECONDS=$((SECONDS + MOCK_SLEEP_SECONDS))
  simulated_seconds=$((simulated_seconds + MOCK_SLEEP_SECONDS))
}
${deployConsumersRunScript()}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
          FAIL_TASK_INSPECTION: options.failTaskInspection ? "1" : "0",
          IMAGE_TAG: "test",
          MOCK_SLEEP_SECONDS: (options.sleepSeconds ?? 10).toString(),
          RUNNER_TEMP: temporaryDirectory,
          SCENARIO_DIR: scenarioDirectory,
          STACK_NAME: "dofek",
          STATE_DIR: stateDirectory,
        },
      },
    );

    return result;
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

const STABLE_OBSERVATION = {
  replicas: "1/1",
  taskId: "stable-task",
  updateState: "completed",
} satisfies ServiceObservation;

describe("deploy-web-stack workflow contract", () => {
  it("quiesces the migration-running worker before the dependency stack apply", () => {
    const stepStart = workflowText.indexOf(
      "      - name: Apply dependency stack before migrations",
    );
    const stepEnd = workflowText.indexOf("\n      - name: Wait for Postgres writable", stepStart);

    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(stepEnd).toBeGreaterThan(stepStart);
    expect(workflowText.slice(stepStart, stepEnd)).toContain(
      "-c deploy/stack.migration-quiesce.yml",
    );
  });

  it("keeps ClickHouse consumers quiesced when CDC configuration fails", () => {
    expect(workflowText).toContain(
      `      - name: Deploy ClickHouse consumer services
        id: deploy_stack_full
        if: success() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.configure_clickhouse_cdc.conclusion == 'success'`,
    );
  });

  it("reports the operator action when consumers remain quiesced", () => {
    expect(workflowText).toContain(
      `      - name: Report quiesced ClickHouse consumers
        if: failure() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.deploy_stack_full.conclusion == 'skipped'`,
    );
    expect(workflowText).toContain("ClickHouse consumers remain quiesced");
    expect(workflowText).toContain("rerun the deployment");
  });

  it("requires the same running task to remain converged for 60 seconds", () => {
    const result = runDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "dofek_analytics-worker task stable-task has remained converged for 60s",
    );
    expect(result.stdout).toContain(
      "dofek_metric-stream-clickhouse-sink task stable-task has remained converged for 60s",
    );
  });

  it("restarts the stability window when Swarm replaces the task", () => {
    const result = runDeployConsumers({
      analyticsWorker: [
        { ...STABLE_OBSERVATION, taskId: "replaced-task" },
        { ...STABLE_OBSERVATION, taskId: "replacement-task" },
      ],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[10s] dofek_analytics-worker task changed from replaced-task to replacement-task; resetting stability window",
    );
    expect(result.stdout).toContain(
      "[70s] dofek_analytics-worker task replacement-task has remained converged for 60s",
    );
  });

  it("restarts the stability window after a transient zero-replica state", () => {
    const result = runDeployConsumers({
      analyticsWorker: [
        STABLE_OBSERVATION,
        { ...STABLE_OBSERVATION, replicas: "0/1" },
        STABLE_OBSERVATION,
      ],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[10s] dofek_analytics-worker lost convergence; resetting stability window for task stable-task",
    );
    expect(result.stdout).toContain(
      "[80s] dofek_analytics-worker task stable-task has remained converged for 60s",
    );
  });

  it.each([
    "rollback_started",
    "paused",
  ])("fails when the service update state is %s", (updateState) => {
    const result = runDeployConsumers({
      analyticsWorker: [{ ...STABLE_OBSERVATION, updateState }],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      updateState === "paused"
        ? "dofek_analytics-worker update is paused"
        : "dofek_analytics-worker did not finish deployment cleanly",
    );
  });

  it("fails when the service does not converge before the 20-minute deadline", () => {
    const result = runDeployConsumers(
      {
        analyticsWorker: [{ replicas: "0/1", taskId: "starting-task", updateState: "updating" }],
        metricStreamClickhouseSink: [STABLE_OBSERVATION],
      },
      { sleepSeconds: 1200 },
    );

    expect(result.status).toBe(124);
    expect(result.stdout).toContain("dofek_analytics-worker did not converge before timeout");
  });

  it("fails immediately when Swarm task inspection fails", () => {
    const result = runDeployConsumers(
      {
        analyticsWorker: [STABLE_OBSERVATION],
        metricStreamClickhouseSink: [STABLE_OBSERVATION],
      },
      { failTaskInspection: true, sleepSeconds: 1200 },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("mock task inspection failed");
    expect(result.stdout).not.toContain("did not converge before timeout");
  });
});
