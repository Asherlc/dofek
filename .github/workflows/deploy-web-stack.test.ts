import {
  STABLE_OBSERVATION,
  serializeScenario,
  runDeployConsumers as runDeployConsumersFixture,
  type ConsumerScenarios,
  type DeployConsumerOptions,
  type DeployQuiescedOptions,
  type ServiceObservation,
  currentKafkaImage,
  requestedKafkaImage,
  runKafkaImageFixture,
  runKafkaInstallerFixture,
  MOCK_DOCKER,
  runKafkaBackendFixture,
  runTopicPolicyFixture,
  runPeerdbMigrationFixture,
} from "./deploy-web-stack-test-helpers.ts";
import { deployTestDigest, deployTestOldImage, deployTestRepository, runDeployImageFixture } from "../../scripts/deploy-image-test-helpers.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowText = readFileSync(".github/workflows/deploy-web-stack.yml", "utf8");
const otaImage = `${deployTestRepository}-ota@${deployTestDigest}`;

describe("PeerDB catalog migration image", () => {
  const image = `ghcr.io/peerdb-io/flow-api:stable-v0.37.15@sha256:${"d".repeat(64)}`;

  it("runs the inspected immutable image before CDC preparation", () => {
    const result = runPeerdbMigrationFixture(workflowRunScript("Migrate PeerDB flow catalog"), image);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls[0]).toContain("fixture_peerdb-flow-api");
    expect(result.calls.find(call => call[0] === "run")).toContain(image);
    expect(result.stdout).toContain("CDC-PREPARE");
    expect(result.stdout + result.stderr).not.toContain("fixture-catalog-password");
  });

  it.each([
    "ghcr.io/peerdb-io/flow-api:stable-v0.37.15",
    "",
    "ghcr.io/peerdb-io/flow-api@sha256:abc",
    `ghcr.io/peerdb-io/flow-api@sha256:${"g".repeat(64)}`,
    `${image}suffix`,
  ])("rejects an unresolved or invalid image before migration: %s", candidate => {
    const result = runPeerdbMigrationFixture(workflowRunScript("Migrate PeerDB flow catalog"), candidate);
    expect(result.status).not.toBe(0);
    expect(result.calls.some(call => call[0] === "run")).toBe(false);
    expect(result.stdout).not.toContain("CDC-PREPARE");
  });

  it("stops before CDC preparation when the stock migration fails", () => {
    const result = runPeerdbMigrationFixture(workflowRunScript("Migrate PeerDB flow catalog"), image, 42);
    expect(result.status).toBe(42);
    expect(result.stdout).not.toContain("CDC-PREPARE");
  });
});

describe("Kafka image upgrades", () => {
  it("resolves the requested manifest image separately from the running broker", () => {
    const result = runKafkaImageFixture(
      workflowRunScript("Resolve Kafka deployment images"), currentKafkaImage,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.environment.KAFKA_IMAGE).toBe(requestedKafkaImage);
    expect(result.environment.CURRENT_KAFKA_IMAGE).toBe(currentKafkaImage);
  });
  it("rejects a mutable running broker image before probing", () => {
    const result = runKafkaImageFixture(
      workflowRunScript("Resolve Kafka deployment images"), "apache/kafka:4.4.0",
    );
    expect(result.status).not.toBe(0);
    expect(result.environment).toEqual({});
  });
  it.each([
    "Wait for Kafka API readiness (external client)",
    "Verify Kafka after dependency stack apply",
    "Verify Kafka after requested-image stack apply",
    "Verify Kafka before restoring consumers",
    "Verify Kafka after full stack apply",
  ])("uses the selected image for %s", step => {
    const result = runKafkaImageFixture(workflowRunScript(step));
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.find(call => call[0] === "run")).toContain(requestedKafkaImage);
  });
  it("probes the running version before an upgrade", () => {
    const result = runKafkaImageFixture(
      workflowRunScript("Wait for Kafka API readiness (external client)"),
      currentKafkaImage, currentKafkaImage,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.find(call => call[0] === "run")).toContain(currentKafkaImage);
  });
  it("rejects a stale broker after the dependency stack apply", () => {
    const result = runKafkaImageFixture(
      workflowRunScript("Verify Kafka after dependency stack apply"), currentKafkaImage,
    );
    expect(result.status).not.toBe(0);
    expect(result.calls.some(call => call[0] === "run")).toBe(false);
  });
});

describe("Kafka JMX exporter installer", () => {
  function runInstaller(failure: "checksum" | "install" | "" = "") {
    return runKafkaInstallerFixture(workflowRunScript("Install Kafka JMX exporter"), failure);
  }

  it("rejects a bad runner download before creating a Docker installer", () => {
    const result = runInstaller("checksum");
    expect(result.status).not.toBe(0);
    expect(result.calls.some((call) => call[0] === "docker")).toBe(false);
  });

  it("installs and verifies the pinned jar through the requested app image", () => {
    const result = runInstaller();
    expect(result.status, result.stderr).toBe(0);
    const curlCall = result.calls.find((call) => call[0] === "curl");
    expect(curlCall).toContain("--fail");
    expect(curlCall).toContain("--location");
    expect(curlCall?.join(" ")).toContain("/releases/download/1.7.0/jmx_prometheus_javaagent-1.7.0.jar");
    expect(result.calls.find((call) => call[0] === "sha256sum")?.[1]).toContain(
      "0ad843261c567d1924a017d542e14c40f2afff523d940c25ee000742fde4b3a9",
    );
    const dockerCall = result.calls.find((call) => call[0] === "docker");
    expect(dockerCall).toContain("run");
    expect(dockerCall).toContain("--rm");
    expect(dockerCall).toContain("-i");
    expect(dockerCall).toContain("--user");
    expect(dockerCall).toContain("0:0");
    expect(dockerCall).toContain(`${deployTestRepository}@${deployTestDigest}`);
    expect(dockerCall?.join(" ")).toContain("source=/mnt/dofek-data/kafka/plugins,target=/plugins");
    expect(dockerCall?.join(" ")).toContain("/plugins/jmx/1.7.0/jmx_prometheus_javaagent-1.7.0.jar");
  });

  it("propagates Docker installer failures", () => {
    const result = runInstaller("install");
    expect(result.status).toBe(42);
  });
});

describe("consumed Kafka tiered backend", () => {
  it.each(["", "bucket", "prefix", "credential", "worker"])("checks actual broker and worker scope: %s", (drift) => {
    const result = runKafkaBackendFixture(workflowRunScript("Verify Kafka tiered backend before migrations"), drift);
    expect(result.status === 0, result.stderr).toBe(drift === "");
    expect(result.stdout + result.stderr).not.toContain("fixture-secret");
    if (!drift) expect(result.stdout).toContain("Kafka broker and worker tiered backend match");
  });
});

describe("deploy-owned Kafka topic policy", () => {
  function policyScript() {
    return ["Converge Kafka metric-stream topic policy", "Verify Kafka metric-stream topic policy", "Verify Kafka topic policy after consumer startup"]
      .map(workflowRunScript).join("\n");
  }

  it("incrementally configures each actual route with its role policy before readback", () => {
    const topics = runTopicPolicyFixture(workflowRunScript("Verify Kafka metric-stream topics"));
    expect(topics.status, topics.stderr).toBe(0);
    expect(topics.calls.every(call => call.includes(requestedKafkaImage))).toBe(true);
    const result = runTopicPolicyFixture(policyScript());
    expect(result.status, result.stderr).toBe(0);
    const updates = result.calls.filter((call) => call.includes("--alter"));
    expect(updates.map((call) => [call[call.indexOf("--entity-name") + 1], call[call.indexOf("--add-config") + 1]])).toEqual([
      ["source", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=-1,local.retention.bytes=1073741824,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
      ["source.quarantine.v1", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=1073741824,local.retention.bytes=268435456,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
      ["live", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=-1,local.retention.bytes=1073741824,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
      ["live.quarantine.v1", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=1073741824,local.retention.bytes=268435456,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
      ["history", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=-1,local.retention.bytes=1073741824,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
      ["history.quarantine.v1", "cleanup.policy=delete,retention.ms=604800000,retention.bytes=1073741824,local.retention.bytes=268435456,local.retention.ms=86400000,segment.ms=3600000,segment.bytes=134217728,remote.storage.enable=true"],
    ]);
    for (const update of updates) {
      expect(update).toContain(requestedKafkaImage);
      expect(update).toContain("/opt/kafka/bin/kafka-configs.sh");
      expect(update).toContain("fixture_default");
      expect(update).toContain("--rm");
    }
    const verifiers = result.calls.filter((call) => call.includes("node"));
    expect(verifiers).toHaveLength(2);
    expect(verifiers[0]).toContain("ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.stdout).toContain("RESTORE-CONSUMERS");
  });

  it("rejects aliased routes before any topic update", () => {
    const result = runTopicPolicyFixture(policyScript(), "", ["source", "source", "history"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("topic routes must be distinct");
    expect(result.calls).toEqual([]);
  });

  it.each([["alter", 64], ["verify", 65]] as const)("stops before consumer restoration on %s failure", (failure, status) => {
    const result = runTopicPolicyFixture(policyScript(), failure);
    expect(result.status).toBe(status);
    expect(result.stdout).not.toContain("RESTORE-CONSUMERS");
  });
});

function deployConsumersRunScript(): string {
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

function workflowRunScript(name: string): string {
  const workflow = z.object({ jobs: z.object({ "web-stack": z.object({
    steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
  }) }) }).parse(parse(workflowText));
  const script = workflow.jobs["web-stack"].steps.find((step) => step.name === name)?.run;
  if (!script) throw new Error(`Could not find the workflow step: ${name}`);
  return script;
}

function deployQuiescedRunScript(): string {
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

function runDeployConsumers(scenarios: ConsumerScenarios, options: DeployConsumerOptions = {}) {
  return runDeployConsumersFixture(deployConsumersRunScript(), scenarios, options);
}

function runDeployQuiesced(
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
    writeFileSync(pnpmPath, "#!/usr/bin/env bash\n[ \"$1\" = tsx ] && [ \"$2\" = scripts/verify-deploy-image.ts ]\n");
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


describe("deploy-web-stack workflow contract", () => {
  it("keeps PeerDB contract gates around migrations and before consumer restoration", () => {
    const orderedSteps = [
      "Wait for PeerDB before migrations",
      "Prepare PeerDB CDC contract",
      "Run migrations",
      "Configure ClickHouse CDC",
      "Finalize PeerDB CDC contract",
      "Verify PeerDB CDC causal markers",
      "Deploy and verify remaining services",
    ];
    const positions = orderedSteps.map((name) => workflowText.indexOf(`      - name: ${name}`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflowText).toContain(
      "steps.verify_peerdb_cdc_contract.conclusion == 'success'",
    );
  });

  it("continues CDC gates after a terminal web rollback before failing the deployment", () => {
    const orderedSteps = [
      "Deploy stack without ClickHouse consumers",
      "Wait for Postgres writable after stack deploy",
      "Wait for ClickHouse after stack deploy",
      "Wait for PeerDB after stack deploy",
      "Configure ClickHouse CDC",
      "Finalize PeerDB CDC contract",
      "Verify PeerDB CDC causal markers",
      "Deploy and verify remaining services",
      "Fail deployment after restoring processing services when web rolled back",
    ];
    const positions = orderedSteps.map((name) =>
      name === "Wait for PeerDB after stack deploy"
        ? workflowText.indexOf(
            "      - name: Wait for PeerDB\n",
            workflowText.indexOf("Deploy stack without ClickHouse consumers"),
          )
        : workflowText.indexOf(`      - name: ${name}`),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflowText).toContain(
      "if: always() && steps.deploy_stack_quiesced.outputs.web_convergence_failed == 'true' && steps.deploy_stack_full.outcome == 'success'",
    );
    expect(workflowText).toContain(
      "steps.deploy_stack_quiesced.outputs.web_convergence_failed != 'true'",
    );
    expect(workflowText).toContain("### Web deployment failed after processing services were restored");
  });

  it.each(["Finalize PeerDB CDC contract", "Verify PeerDB CDC causal markers"])(
    "runs %s as the named-volume owner",
    (step) => {
      expect(workflowRunScript(step)).toContain("--user 0:0");
    },
  );

  it.each([
    ["Apply dependency stack before migrations", "web-pre-migration.env", deployTestOldImage],
    ["Deploy stack without ClickHouse consumers", "web.env", deployTestRepository + "@" + deployTestDigest],
    ["Deploy and verify remaining services", "web.env", deployTestRepository + "@" + deployTestDigest],
  ])("selects the correct web environment in %s", (step, expectedFile, expectedImage) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
docker() {
  if [ "$1" = service ] && [ "$2" = inspect ]; then
    printf '%s\\n' 'ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    return 0
  fi
  return 1
}
node() {
  printf 'selected-web-env=%s image=%s\\n' "$WEB_ENV_FILE" "$APP_IMAGE"
  return 23
}
timeout() { shift; "$@"; }
${workflowRunScript(step)}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_IMAGE: expectedImage,
          MIGRATION_DEPLOYMENT_MODE: "rolling",
          WEB_ENV_FILE: "/synthetic/web.env",
          WEB_PRE_MIGRATION_ENV_FILE: "/synthetic/web-pre-migration.env",
          RUNNER_TEMP: "/synthetic",
          STACK_NAME: "dofek",
          STACK_FILE_FLAGS: "-c deploy/docker-compose.yml",
        },
      },
    );
    expect(result.status).toBe(23);
    expect(result.stdout).toContain(
      `selected-web-env=/synthetic/${expectedFile} image=${expectedImage}`,
    );
  });

  it("accepts processing reconciliation quiesced at 0/0 on the requested image", () => {
    const result = runDeployQuiesced(
      [
        {
          desiredReplicas: "0",
          image: "ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          replicas: "0/0",
          taskId: "",
          updateState: "completed",
        },
      ],
      { sleepSeconds: 2100 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "dofek_processing-reconciliation image=ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa replicas=0/0",
    );
  });

  it("fails processing reconciliation quiesced on an old image", () => {
    const result = runDeployQuiesced(
      [
        {
          desiredReplicas: "0",
          image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          replicas: "0/0",
          taskId: "",
          updateState: "completed",
        },
      ],
      { sleepSeconds: 2100 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "dofek_processing-reconciliation is using ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, expected ghcr.io/asherlc/dofek@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("defers a terminal web rollback and records the outcome", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [{
          ...STABLE_OBSERVATION,
          image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          taskId: "failed-web-task",
          updateState: "rollback_completed",
        }],
      },
    });

    expect(result.stderr).toBe("");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("terminal rollback or reverted image");
    expect(result.stdout).toContain("diagnostic task output for dofek_web");
    expect(result.githubOutput).toContain("web_convergence_failed=true");
  });

  it.each(["rollback_started", "rollback_completed", "rollback_paused", "paused"])(
    "fails maintenance rollout immediately when web is %s",
    (updateState) => {
      const result = runDeployQuiesced([STABLE_OBSERVATION], {
        deploymentMode: "maintenance",
        serviceObservations: {
          dofek_web: [{
            ...STABLE_OBSERVATION,
            desiredReplicas: "0",
            replicas: "0/0",
            image: "ghcr.io/asherlc/dofek:previous",
            updateState,
          }],
        },
        sleepSeconds: 2100,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Maintenance rollout failed");
      expect(result.githubOutput).toContain("web_convergence_failed=false");
      expect(result.githubOutput).not.toContain("web_convergence_failed=true");
    },
  );

  it("waits for the rolled-back web service to regain all desired replicas", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [
          {
            ...STABLE_OBSERVATION,
            replicas: "0/1",
            image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            updateState: "rollback_completed",
          },
          {
            ...STABLE_OBSERVATION,
            image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            updateState: "rollback_completed",
          },
        ],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("waiting for the rolled-back web replicas to converge");
    expect(result.githubOutput).toContain("web_convergence_failed=true");
  });

  it("waits for an in-progress web rollback to settle before deferring it", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [
          { ...STABLE_OBSERVATION, updateState: "rollback_started" },
          {
            ...STABLE_OBSERVATION,
            image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            updateState: "rollback_completed",
          },
        ],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("waiting for the web rollback to settle");
    expect(result.githubOutput).toContain("web_convergence_failed=true");
  });

  it("fails closed when the web rollback does not settle before the deadline", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [{ ...STABLE_OBSERVATION, updateState: "rollback_started" }],
      },
      sleepSeconds: 2100,
    });

    expect(result.status).toBe(124);
    expect(result.stdout).toContain("dofek_web rollback did not settle before timeout");
    expect(result.githubOutput).toContain("web_convergence_failed=false");
  });

  it("keeps a stack command failure fatal without recording a deferred web failure", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], { stackDeployStatus: 42 });

    expect(result.status).toBe(42);
    expect(result.githubOutput).toContain("web_convergence_failed=false");
    expect(result.githubOutput).not.toContain("web_convergence_failed=true");
  });

  it("keeps an active web update at the deadline fatal", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [{ ...STABLE_OBSERVATION, replicas: "0/1", updateState: "updating" }],
      },
      sleepSeconds: 2100,
    });

    expect(result.status).toBe(124);
    expect(result.stdout).toContain("dofek_web did not converge before timeout");
    expect(result.githubOutput).toContain("web_convergence_failed=false");
    expect(result.githubOutput).not.toContain("web_convergence_failed=true");
  });

  it("keeps an unknown web update state fatal", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [{
          ...STABLE_OBSERVATION,
          image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          updateState: "",
        }],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("dofek_web is using ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(result.githubOutput).toContain("web_convergence_failed=false");
  });

  it("keeps a non-web convergence failure fatal", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_worker: [{ ...STABLE_OBSERVATION, image: "ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("dofek_worker is using ghcr.io/asherlc/dofek:previous@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(result.githubOutput).not.toContain("web_convergence_failed=true");
  });

  it("keeps a paused Kafka update fatal before continuing the release", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_kafka: [{ ...STABLE_OBSERVATION, updateState: "paused" }],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("dofek_kafka update is paused");
    expect(result.githubOutput).not.toContain("web_convergence_failed=true");
  });

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

  it("waits for the pre-migration web update before running migrations", () => {
    const dependencyStep = workflowText.indexOf(
      "      - name: Apply dependency stack before migrations",
    );
    const convergenceStep = workflowText.indexOf(
      "      - name: Wait for pre-migration web convergence",
    );
    const migrationStep = workflowText.indexOf("      - name: Run migrations");

    expect(dependencyStep).toBeGreaterThanOrEqual(0);
    expect(convergenceStep).toBeGreaterThan(dependencyStep);
    expect(migrationStep).toBeGreaterThan(convergenceStep);
    expect(workflowText.slice(convergenceStep, migrationStep)).toContain(
      '"${STACK_NAME}_web"',
    );
    expect(workflowText.slice(convergenceStep, migrationStep)).toContain(
      "UpdateStatus.State",
    );
  });

  it("keeps ClickHouse consumers quiesced when CDC configuration fails", () => {
    expect(workflowText).toContain(
      `      - name: Deploy and verify remaining services
        id: deploy_stack_full
        if: success() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.configure_clickhouse_cdc.conclusion == 'success'`,
    );
  });

  it("reports the operator action when processing services remain quiesced", () => {
    expect(workflowText).toContain(
      `      - name: Report quiesced processing services
        if: failure() && steps.deploy_stack_quiesced.conclusion == 'success' && steps.deploy_stack_full.conclusion == 'skipped'`,
    );
    expect(workflowText).toContain("Processing services remain quiesced");
    expect(workflowText).toContain(
      "analytics-worker, all three metric-stream ClickHouse sinks, and processing-reconciliation remain at zero replicas.",
    );
    expect(workflowText).toContain("rerun the deployment");
    expect(workflowText).toContain(
      'if [ "${{ steps.deploy_stack_quiesced.outputs.web_convergence_failed }}" = "true" ]; then',
    );
    expect(workflowText).toContain("its prior Swarm configuration remains in place");
  });

  it("verifies the canonical OTA image before declaring rollout complete", () => {
    const result = runDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.imageVerificationArgs).toContain(`scripts/verify-deploy-image.ts ${otaImage} dofek_ota`);
    expect(result.stdout).toContain("dofek_ota task stable-task has remained converged for 60s");
  });

  it("fails rollout when the OTA running-image verifier rejects a converged task", () => {
    const result = runDeployConsumers(
      { analyticsWorker: [STABLE_OBSERVATION], metricStreamClickhouseSink: [STABLE_OBSERVATION] },
      { failOtaImageVerification: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OTA running image mismatch");
    expect(result.stdout).not.toContain("dofek_ota task stable-task has remained converged");
  });

  it("requires the same running task to remain converged for 60 seconds", () => {
    const result = runDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "dofek_analytics-worker task stable-task has remained converged for 60s",
    );
    expect(result.stdout).toContain(
      "dofek_metric-stream-clickhouse-sink task stable-task has remained converged for 60s",
    );
  });

  it("restores processing services without changing the rolled-back web service", () => {
    const result = runDeployConsumers(
      {
        analyticsWorker: [STABLE_OBSERVATION],
        metricStreamClickhouseSink: [STABLE_OBSERVATION],
      },
      {
        webConvergenceFailed: true,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stackDeployArgs).not.toContain("--prune");
    expect(workflowText).toContain("delete config.services.web");
    expect(workflowText).toContain("docker stack config --skip-interpolation");
  });

  it("does not add the web rollback override to a normal full-stack deploy", () => {
    const result = runDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stackDeployArgs).toContain("--prune");
  });

  it("restarts the stability window when Swarm replaces the task", () => {
    const result = runDeployConsumers({
      analyticsWorker: [
        { ...STABLE_OBSERVATION, taskId: "replaced-task" },
        { ...STABLE_OBSERVATION, taskId: "replacement-task" },
      ],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "[130s] dofek_analytics-worker task changed from replaced-task to replacement-task; resetting stability window",
    );
    expect(result.stdout).toContain(
      "[190s] dofek_analytics-worker task replacement-task has remained converged for 60s",
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

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "[130s] dofek_analytics-worker lost convergence; resetting stability window for task stable-task",
    );
    expect(result.stdout).toContain(
      "[200s] dofek_analytics-worker task stable-task has remained converged for 60s",
    );
  });

  it.each(["rollback_started", "paused"])(
    "fails when the service update state is %s",
    (updateState) => {
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
    },
  );

  it("fails when the service does not converge before the 20-minute deadline", () => {
    const result = runDeployConsumers(
      {
        analyticsWorker: [{ replicas: "0/1", taskId: "starting-task", updateState: "updating" }],
        metricStreamClickhouseSink: [STABLE_OBSERVATION],
      },
      { sleepSeconds: 60 },
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


function runImageSelection() {
  return runDeployImageFixture({ script: workflowRunScript("Pull deploy images") });
}

describe("deploy workflow image selection", () => {
  it("passes both pinned images to migration history selection", () => {
    const requested = `${deployTestRepository}@${deployTestDigest}`;
    const result = spawnSync(
      "bash",
      [
        "-e", "-o", "pipefail", "-c",
        `
pnpm() { printf '%s\\n' "$@"; }
${workflowRunScript("Select migration deployment mode from image histories")}
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_IMAGE: requested,
          PRE_MIGRATION_APP_IMAGE: deployTestOldImage,
          STACK_NAME: "dofek",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "tsx", "scripts/prepare-migration-deployment.ts", requested, "dofek", deployTestOldImage,
    ]);
  });

  it.each(["rolling", "maintenance"])(
    "passes the old pinned image and old web environment through dotenv stack interpolation for %s",
    (mode) => {
      const script = ["Create dotenv command runner", "Apply dependency stack before migrations"]
        .map(workflowRunScript).join("\n");
      const result = runDeployImageFixture({
        script,
        environment: {
          APP_IMAGE: deployTestOldImage,
          MIGRATION_DEPLOYMENT_MODE: mode,
          MIGRATION_MAINTENANCE_BOUNDARY: "0148_compute_climbing_attempt_outcome",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`DEPLOY_IMAGE=${deployTestOldImage}`);
      expect(result.stdout).toContain("WEB_ENV_FILE=old-web.env");
      const apply = result.calls.find((call) => call[0] === "stack" && call[1] === "deploy");
      expect(apply).toEqual(expect.arrayContaining([
        "deploy/stack.cdc-quiesce.yml", "deploy/stack.migration-quiesce.yml",
      ]));
      expect(apply?.includes("deploy/stack.maintenance.yml")).toBe(mode === "maintenance");
    },
  );
  it("pins the selected maintenance boundary through dotenv loading", () => {
    const selectedBoundary = "0148_compute_climbing_attempt_outcome";
    const contaminateFixture = String.raw`
printf '%s\n' 'MIGRATION_MAINTENANCE_BOUNDARY=stale_boundary' >> "$INFISICAL_ENV_FILE"
printf '\n%s\n' 'console.log("MAINTENANCE_BOUNDARY=" + process.env.MIGRATION_MAINTENANCE_BOUNDARY);' >> "$RUNNER_TEMP/docker"
`;
    const script = [
      contaminateFixture,
      workflowRunScript("Create dotenv command runner"),
      workflowRunScript("Apply dependency stack before migrations"),
    ].join("\n");
    const result = runDeployImageFixture({
      script,
      environment: {
        APP_IMAGE: deployTestOldImage,
        MIGRATION_DEPLOYMENT_MODE: "maintenance",
        MIGRATION_MAINTENANCE_BOUNDARY: selectedBoundary,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`MAINTENANCE_BOUNDARY=${selectedBoundary}`);
  });

  it("pins the validated image even when the registry tag moves after resolution", () => {
    const result = runImageSelection();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("image_ref=" + deployTestRepository + "@" + deployTestDigest + "\n");
    expect(result.calls).toContainEqual(["pull", deployTestRepository + "@" + deployTestDigest]);
  });

  it("preserves the existing desired digest for the pre-migration application", () => {
    const result = runImageSelection();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("pre_migration_image_ref=" + deployTestOldImage + "\n");
  });
});
