import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const QUIESCENCE_TIMEOUT_MS = 35 * 60 * 1_000;
const POLL_INTERVAL_MS = 5_000;
const MIGRATION_CONSUMERS = [
  "worker",
  "analytics-worker",
  "metric-stream-clickhouse-sink",
  "metric-stream-live-clickhouse-sink",
  "metric-stream-history-clickhouse-sink",
  "processing-reconciliation",
];
const TERMINAL_TASK_STATES = new Set(["shutdown", "complete", "failed", "rejected", "remove"]);
const serviceInspectionSchema = z.tuple([
  z.object({
    Spec: z.object({
      Mode: z.object({ Replicated: z.object({ Replicas: z.number().int().nonnegative() }) }),
    }),
    UpdateStatus: z
      .object({
        State: z.enum([
          "updating",
          "completed",
          "paused",
          "rollback_started",
          "rollback_paused",
          "rollback_completed",
        ]),
      })
      .optional(),
  }),
]);
const taskStateSchema = z.enum([
  "new",
  "allocated",
  "pending",
  "assigned",
  "accepted",
  "preparing",
  "ready",
  "starting",
  "running",
  "complete",
  "shutdown",
  "failed",
  "rejected",
  "remove",
  "orphaned",
]);
const taskSnapshotSchema = z.object({
  ID: z.string().min(1),
  CurrentState: z.string().min(1),
});
function dockerExec(arguments_: string[], deadline: number): string {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    timeout: Math.max(1, deadline - Date.now()),
  });
}

function inspectService(serviceName: string, deadline: number): string[] {
  const docker = (arguments_: string[]) => dockerExec(arguments_, deadline);
  const [service] = serviceInspectionSchema.parse(
    JSON.parse(docker(["service", "inspect", serviceName])),
  );
  if (service.Spec.Mode.Replicated.Replicas !== 0) {
    throw new Error(`${serviceName} must have zero replicas before migrations can start.`);
  }
  const updateState = service.UpdateStatus?.State;
  if (
    updateState === "paused" ||
    updateState === "rollback_started" ||
    updateState === "rollback_paused"
  ) {
    throw new Error(`${serviceName} cannot quiesce while its update state is ${updateState}.`);
  }
  const tasks = docker(["service", "ps", "--no-trunc", "--format", "{{json .}}", serviceName])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const task = taskSnapshotSchema.parse(JSON.parse(line));
      const state = taskStateSchema.parse(
        task.CurrentState.trim().split(/\s+/, 1)[0]?.toLowerCase(),
      );
      return { ID: task.ID, State: state };
    });
  return tasks
    .filter((task) => !TERMINAL_TASK_STATES.has(task.State))
    .map((task) => `${serviceName}: ${task.ID}=${task.State}`);
}

function migrationConsumerServices(
  stackName: string,
  deploymentMode: "rolling" | "maintenance",
): string[] {
  if (!stackName.trim()) throw new Error("A stack name is required for migration quiescence.");
  const consumers =
    deploymentMode === "maintenance" ? [...MIGRATION_CONSUMERS, "web"] : MIGRATION_CONSUMERS;
  return consumers.map((consumer) => `${stackName}_${consumer}`);
}

async function waitForServicesToStop(
  services: readonly string[],
  deploymentMode: "rolling" | "maintenance",
  deadline: number,
): Promise<void> {
  let waiting: string[] = [];
  while (Date.now() < deadline) {
    waiting = services.flatMap((service) => inspectService(service, deadline));
    if (waiting.length === 0) {
      console.log(`Migration consumers are stopped for ${deploymentMode} deployment.`);
      return;
    }
    console.log(`Waiting for migration quiescence: ${waiting.join(", ")}`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now()))),
    );
  }
  throw new Error(`Migration quiescence timed out after 35 minutes: ${waiting.join(", ")}`);
}

async function runMigrationQuiescence(
  stackName: string,
  deploymentMode: "rolling" | "maintenance",
  drain: boolean,
): Promise<void> {
  const services = migrationConsumerServices(stackName, deploymentMode);
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  let watched = services;
  if (drain) {
    const deployed = new Set(
      dockerExec(["service", "ls", "--format", "{{.Name}}"], deadline)
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    );
    watched = services.filter((service) => deployed.has(service));
    if (watched.length > 0) {
      dockerExec(
        ["service", "scale", "--detach=true", ...watched.map((service) => `${service}=0`)],
        deadline,
      );
    }
  }
  await waitForServicesToStop(watched, deploymentMode, deadline);
}

export async function waitForMigrationQuiescence(
  stackName: string,
  deploymentMode: "rolling" | "maintenance",
): Promise<void> {
  await runMigrationQuiescence(stackName, deploymentMode, false);
}

export async function drainMigrationConsumers(
  stackName: string,
  deploymentMode: "rolling" | "maintenance",
): Promise<void> {
  await runMigrationQuiescence(stackName, deploymentMode, true);
}

const commandPath = process.argv[1];
if (commandPath && import.meta.url === pathToFileURL(commandPath).href) {
  const args = process.argv.slice(2);
  const drain = args[0] === "--drain";
  const [stackName, deploymentMode, ...extra] = drain ? args.slice(1) : args;
  if (
    !stackName ||
    (deploymentMode !== "rolling" && deploymentMode !== "maintenance") ||
    extra.length > 0
  ) {
    throw new Error(
      "Usage: pnpm tsx scripts/wait-migration-quiescence.ts [--drain] <stack-name> <rolling|maintenance>",
    );
  }
  if (drain) await drainMigrationConsumers(stackName, deploymentMode);
  else await waitForMigrationQuiescence(stackName, deploymentMode);
}
