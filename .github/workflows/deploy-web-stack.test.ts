import {
  STABLE_OBSERVATION,
  currentKafkaImage,
  deployedStackServices,
  requestedKafkaImage,
  runClickHouseReadinessFixture,
  runDeployQuiesced,
  runFlyDrainFixture,
  runKafkaBackendFixture,
  runKafkaImageFixture,
  runKafkaInstallerFixture,
  runMigrationHistorySelectionFixture,
  runPeerdbMigrationFixture,
  runPipedashVerificationFixture,
  runPreMigrationWebConvergence,
  runPreMigrationWebLsFailureFixture,
  runTopicPolicyFixture,
  runWebEnvSelectionFixture,
  runWorkflowDeployConsumers,
  webStackSteps,
  workflowRunScript,
  workflowStackServiceFilter,
  workflowText,
} from "./deploy-web-stack-test-helpers.ts";
import { deployTestDigest, deployTestOldImage, deployTestRepository, runDeployImageFixture } from "../../scripts/deploy-image-test-helpers.ts";
import { describe, expect, it } from "vitest";

const otaImage = `${deployTestRepository}-ota@${deployTestDigest}`;
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const CONTROL_CHECKOUT_PATH = "control-checkout";

describe("Pipedash production access verification", () => {
  const execute = (statuses: number[], password?: string, rule?: string) =>
    runPipedashVerificationFixture(
      workflowRunScript("Verify Pipedash health and authentication"), statuses, password, rule,
    );

  it("requires health, anonymous rejection and authenticated access", async () => {
    const requests = await execute([200, 401, 200]);
    expect(requests.map(request => request.url)).toEqual([
      "https://pipedash.dofek.fit/api/v1/health",
      "https://pipedash.dofek.fit/api/v1/providers",
      "https://pipedash.dofek.fit/api/v1/providers",
    ]);
    expect(requests[1]?.authorization).toBeNull();
    expect(requests[2]?.authorization).toBe("Bearer fixture-vault-password");
  });

  it("verifies the checked-out release source when the control workflow is newer", async () => {
    const requests = await execute([200, 401, 200], "fixture-vault-password", "Host(`actions.dofek.fit`)");
    expect(requests.map(request => request.url)).toEqual([
      "https://actions.dofek.fit/api/v1/health",
      "https://actions.dofek.fit/api/v1/providers",
      "https://actions.dofek.fit/api/v1/providers",
    ]);
  });

  it("rejects a router outside dofek.fit before probing", async () => {
    await expect(
      execute([200, 401, 200], "fixture-vault-password", "Host(`dofek.fit.example.test`)"),
    ).rejects.toThrow(/Pipedash.*router/);
  });

  it.each([[503], [200, 200], [200, 403], [200, 401, 401], [200, 401, 500]])(
    "rejects failed access verification: %j", async (...statuses) => {
      await expect(execute(statuses)).rejects.toThrow(/Pipedash/);
    },
  );

  it("rejects a missing vault password before probing the service", async () => {
    await expect(execute([], "")).rejects.toThrow(/PIPEDASH_VAULT_PASSWORD/);
  });

  it("rejects an authenticated redirect at the HTTP boundary", async () => {
    await expect(execute([200, 401, 302])).rejects.toThrow(TypeError);
  });
});

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

describe("deploy-web-stack workflow contract", () => {
  it("converges dependencies and pre-migration web before migrating and restoring consumers", () => {
    const orderedSteps = [
      "Apply dependency stack before migrations",
      "Wait for Postgres writable",
      "Wait for ClickHouse",
      "Apply pre-migration web configuration",
      "Wait for pre-migration web convergence",
      "Wait for PeerDB before migrations",
      "Prepare PeerDB CDC contract",
      "Run migrations",
      "Configure ClickHouse CDC",
      "Finalize PeerDB CDC contract",
      "Verify PeerDB CDC causal markers",
      "Deploy and verify remaining services",
    ];
    const positions = orderedSteps.map((name) => workflowText.indexOf(`      - name: ${name}\n`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflowText).toContain(
      "steps.verify_peerdb_cdc_contract.conclusion == 'success'",
    );
    expect(workflowRunScript("Wait for pre-migration web convergence")).toContain("UpdateStatus.State");
  });

  it("matches pre-migration web replicas by exact name despite web-maintenance", () => {
    const result = runPreMigrationWebConvergence(
      workflowRunScript("Wait for pre-migration web convergence"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dofek_web replicas=2/2 update_state=completed");
    expect(result.stdout).toContain(
      `tsx scripts/verify-deploy-image.ts ${deployTestRepository}@${deployTestDigest} dofek_web`,
    );
  });

  it("drains deployed publishers before the dependency apply and rechecks quiescence afterward", () => {
    const drainStep = "Drain deployed migration publishers before dependency stack apply";
    const applyStep = "Apply dependency stack before migrations";
    const checkStep = "Wait for migration readers and writers to stop";
    const positions = [drainStep, applyStep, checkStep].map((name) =>
      workflowText.indexOf(`      - name: ${name}\n`),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflowRunScript(drainStep)).toBe(
      `pnpm tsx ${CONTROL_CHECKOUT_PATH}/scripts/wait-migration-quiescence.ts --drain "$STACK_NAME" "$MIGRATION_DEPLOYMENT_MODE"`,
    );
    expect(workflowRunScript(checkStep)).toBe(
      'pnpm tsx scripts/wait-migration-quiescence.ts "$STACK_NAME" "$MIGRATION_DEPLOYMENT_MODE"',
    );

    const drain = webStackSteps().find((step) => step.name === drainStep);
    expect(drain?.id).toBe("drain_migration_publishers");
  });

  it("reports an interrupted deploy only after the publisher drain has started", () => {
    const report = webStackSteps().find(
      (step) => step.name === "Report interrupted deployment after publisher drain starts",
    );
    expect(report?.if).toContain("failure()");
    expect(report?.if).toContain(
      "(steps.drain_migration_publishers.conclusion == 'failure' || steps.drain_migration_publishers.conclusion == 'success')",
    );
    expect(report?.if).toContain("steps.deploy_stack_quiesced.conclusion != 'success'");
    expect(report?.if).toContain("steps.deploy_stack_full.conclusion != 'success'");
    expect(report?.run).toContain("Migration publisher replicas may still be at zero");
    expect(report?.run).toContain("Inspect the failed step before restarting the deployment.");
  });

  it("pins candidate and control checkout identities for the migration guard", () => {
    const checkouts = webStackSteps().filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    expect(checkouts.map((step) => step.uses)).toEqual([CHECKOUT_ACTION, CHECKOUT_ACTION]);

    const candidate = checkouts[0]?.with ?? {};
    expect(candidate).toMatchObject({
      ref: "${{ inputs.commit_sha != '' && inputs.commit_sha || github.sha }}",
      "persist-credentials": false,
    });
    expect(candidate).not.toHaveProperty("path");
    expect(candidate).not.toHaveProperty("sparse-checkout");

    const control = checkouts[1]?.with ?? {};
    expect(control).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      "sparse-checkout": "scripts/wait-migration-quiescence.ts",
      "sparse-checkout-cone-mode": false,
      path: CONTROL_CHECKOUT_PATH,
    });
  });

  it.each(["image", "config", "lifecycle", "updating", "no-op"] as const)("waits for ClickHouse readiness for %s", (change) => {
    const result = runClickHouseReadinessFixture(workflowRunScript("Wait for ClickHouse"), change);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ClickHouse is reachable");
    expect(result.stdout.includes("ClickHouse readiness attempt 1/36")).toBe(change !== "no-op");
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

  it("polls the staged Fly Machine version for started state and provider-sync-ready after start --wait", () => {
    const step = "Start the verified production worker image on Fly";
    const script = workflowRunScript(step);
    const startAt = script.indexOf('flyctl machine start --app "$FLY_SYNC_APP_NAME" --wait "$MACHINE_ID"');
    expect(script).toContain('flyctl machine update "$MACHINE_ID" --app "$FLY_SYNC_APP_NAME"');
    expect(script).toContain("--skip-start --yes");
    expect(startAt).toBeGreaterThan(script.indexOf("flyctl machine update"));
    const afterStart = script.slice(startAt);
    expect(afterStart).toContain('flyctl machines list --app "$FLY_SYNC_APP_NAME" --json');
    expect(afterStart).toContain('.[0].state == "started"');
    expect(afterStart).toContain('.name == "provider-sync-ready" and .status == "passing"');
    expect(afterStart).toMatch(/\.version == \$version|\.version == \$staged_version/);
    expect(afterStart).toContain("deadline=$((SECONDS +");
    expect(afterStart).toContain('echo "Fly production runner ${MACHINE_ID} version ${staged_version} started"');
    expect(afterStart).toContain('"provider-sync-ready": ([.checks[]? | select(.name == "provider-sync-ready") | .status] | first // null)');
    expect(afterStart).toMatch(/map\(\{\s*id,\s*version,\s*state,/);
    expect(afterStart).not.toContain(".config");
    expect(afterStart).not.toContain(".output");
  });

  describe("Drain Fly provider sync before database migrations", () => {
    const drain = () => workflowRunScript("Drain Fly provider sync before database migrations");

    it("starts the deadline before the first lookup and stops only on the initial observation", () => {
      const script = drain();
      expect(workflowText).toMatch(
        /- name: Drain Fly provider sync before database migrations\n {8}if: .+\n {8}timeout-minutes: 6\n/,
      );
      expect(script).toContain("deadline=$((SECONDS + 360))");
      expect(script).toContain("initial_observation=true");
      expect(script.indexOf("deadline=$((SECONDS + 360))")).toBeLessThan(script.indexOf('state="$(fly_machine_state)"'));
      expect(script.indexOf('state="$(fly_machine_state)"')).toBeLessThan(script.indexOf('flyctl machine stop "$MACHINE_ID"'));
    });

    it("issues one graceful stop after listing started, then polls to stopped", () => {
      const result = runFlyDrainFixture(drain(), { states: ["started", "stopping", "stopped"] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls[0]).toEqual(["machines", "list", "--app", result.appName, "--json"]);
      expect(result.calls[1]).toEqual([
        "machine", "stop", result.machineId, "--app", result.appName, "--signal", "SIGTERM", "--timeout", "300",
      ]);
      expect(result.calls[1]).not.toContain("--wait-timeout");
      expect(result.calls.slice(2).every((call) => call[0] === "machines" && call[1] === "list")).toBe(true);
      expect(result.calls.filter((call) => call[1] === "stop")).toHaveLength(1);
    });

    it("skips stop when already stopped and observes stopping without stop", () => {
      const stopped = runFlyDrainFixture(drain(), { states: ["stopped"] });
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.calls).toEqual([["machines", "list", "--app", stopped.appName, "--json"]]);
      const stopping = runFlyDrainFixture(drain(), { states: ["stopping", "stopped"] });
      expect(stopping.status, stopping.stderr).toBe(0);
      expect(stopping.calls.every((call) => call[1] === "list")).toBe(true);
      expect(stopping.calls.length).toBeGreaterThan(1);
    });

    it("exits 124 when stopped arrives after the deadline", () => {
      const result = runFlyDrainFixture(drain(), { states: ["stopping", "stopped"], sleepSeconds: 361 });
      expect(result.status).toBe(124);
      expect(result.calls.every((call) => call[1] === "list")).toBe(true);
      expect(result.calls.filter((call) => call[1] === "stop")).toHaveLength(0);
    });

    it("fails immediately on list errors, missing IDs, unexpected states, and stop failures", () => {
      for (const options of [
        { listFails: true }, { missingMachine: true }, { wrongId: true }, { states: ["destroyed"] },
      ] as const) {
        const result = runFlyDrainFixture(drain(), { states: ["started"], ...options });
        expect(result.status).not.toBe(0);
        expect(result.calls.filter((call) => call[1] === "stop")).toHaveLength(0);
      }
      const stopFailure = runFlyDrainFixture(drain(), { states: ["started"], stopFails: true });
      expect(stopFailure.status).not.toBe(0);
      expect(stopFailure.calls.some((call) => call[1] === "stop")).toBe(true);
    });
  });

  it.each([
    "Deploy stack without ClickHouse consumers",
    "Deploy and verify remaining services",
  ])("selects the correct web environment in %s", (step) => {
    const result = runWebEnvSelectionFixture(workflowRunScript(step));
    expect(result.status).toBe(23);
    expect(result.stdout).toContain(
      `selected-web-env=/synthetic/web.env image=${deployTestRepository}@${deployTestDigest}`,
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

  it("matches quiesced web replicas by exact name despite web-maintenance", () => {
    const result = runDeployQuiesced([STABLE_OBSERVATION], {
      serviceObservations: {
        dofek_web: [{ ...STABLE_OBSERVATION, replicas: "2/2", desiredReplicas: "2" }],
        "dofek_web-maintenance": [{ ...STABLE_OBSERVATION, replicas: "1/1" }],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `dofek_web image=${deployTestRepository}@${deployTestDigest} replicas=2/2 update_state=completed`,
    );
    expect(result.githubOutput).toContain("web_convergence_failed=false");
  });

  it.each(["Wait for pre-migration web convergence", "Deploy stack without ClickHouse consumers"])(
    "preserves Docker failures in the exact-name replica pipeline of %s",
    (stepName) => {
      const script = workflowRunScript(stepName);
      const pipelineIndex = script.indexOf("| awk -v name=");
      expect(pipelineIndex).toBeGreaterThan(-1);
      expect(script.indexOf("set -o pipefail")).toBeGreaterThan(-1);
      expect(script.indexOf("set -o pipefail")).toBeLessThan(pipelineIndex);
    },
  );

  it("fails immediately when the pre-migration web replica lookup loses its Docker CLI", () => {
    const result = runPreMigrationWebLsFailureFixture(
      workflowRunScript("Wait for pre-migration web convergence"),
    );
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("mock docker service ls failure");
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
    const result = runWorkflowDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.imageVerificationArgs).toContain(`scripts/verify-deploy-image.ts ${otaImage} dofek_ota`);
    expect(result.stdout).toContain("dofek_ota task stable-task has remained converged for 60s");
  });

  it("fails rollout when the OTA running-image verifier rejects a converged task", () => {
    const result = runWorkflowDeployConsumers(
      { analyticsWorker: [STABLE_OBSERVATION], metricStreamClickhouseSink: [STABLE_OBSERVATION] },
      { failOtaImageVerification: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OTA running image mismatch");
    expect(result.stdout).not.toContain("dofek_ota task stable-task has remained converged");
  });

  it("requires the same running task to remain converged for 60 seconds", () => {
    const result = runWorkflowDeployConsumers({
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
    const result = runWorkflowDeployConsumers(
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
    const result = runWorkflowDeployConsumers({
      analyticsWorker: [STABLE_OBSERVATION],
      metricStreamClickhouseSink: [STABLE_OBSERVATION],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stackDeployArgs).toContain("--prune");
  });

  it("restarts the stability window when Swarm replaces the task", () => {
    const result = runWorkflowDeployConsumers({
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
    const result = runWorkflowDeployConsumers({
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
      const result = runWorkflowDeployConsumers({
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
    const result = runWorkflowDeployConsumers(
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
    const result = runWorkflowDeployConsumers(
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
    const result = runMigrationHistorySelectionFixture(
      workflowRunScript("Select migration deployment mode from image histories"),
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
          STACK_SERVICE_FILTER: workflowStackServiceFilter(),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`DEPLOY_IMAGE=${deployTestOldImage}`);
      expect(result.stdout).toContain("WEB_ENV_FILE=old-web.env");
      const rendered = result.calls.find((call) => call[0] === "stack" && call[1] === "config");
      const apply = result.calls.find((call) => call[0] === "stack" && call[1] === "deploy");
      expect(rendered ?? apply).toEqual(expect.arrayContaining([
        "deploy/stack.cdc-quiesce.yml", "deploy/stack.migration-quiesce.yml",
      ]));
      expect(apply?.includes("deploy/stack.maintenance.yml")).toBe(mode === "maintenance");
      expect(apply).not.toContain("--prune");
      if (mode === "rolling") {
        expect(deployedStackServices(result.stdout)).toEqual({
          clickhouse: { image: "fixture-clickhouse" }, worker: { deploy: { replicas: 0 } },
        });
      }
    },
  );
  it("applies only the old web service with its pre-migration environment", () => {
    const result = runDeployImageFixture({
      script: ["Create dotenv command runner", "Apply pre-migration web configuration"].map(workflowRunScript).join("\n"),
      environment: { APP_IMAGE: deployTestOldImage, STACK_SERVICE_FILTER: workflowStackServiceFilter() },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(deployedStackServices(result.stdout)).toEqual({
      web: { image: deployTestOldImage, env_file: ["old-web.env"], environment: { PASSWORD: "fixture$$token" } },
    });
    expect(result.calls.find((call) => call.slice(0, 2).join(" ") === "stack deploy")).not.toContain("--prune");
  });
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

  it("uses the server image admitted before Terraform instead of resolving its mutable tag again", () => {
    const immutable = `${deployTestRepository}@${deployTestDigest}`;
    const result = runDeployImageFixture({
      script: workflowRunScript("Pull deploy images"),
      environment: { IMAGE_REF: immutable },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls[0]).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      immutable,
      "--format",
      "{{json .Manifest}}",
    ]);
    expect(result.output).toContain(`image_ref=${immutable}\n`);
  });
});
