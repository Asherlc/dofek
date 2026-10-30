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
const taskInspectionsSchema = z.array(
  z.object({
    ID: z.string().min(1),
    Status: z.object({
      State: z.enum([
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
      ]),
    }),
  }),
);

function inspectService(serviceName: string, deadline: number): string[] {
  const docker = (arguments_: string[]) =>
    execFileSync("docker", arguments_, {
      encoding: "utf8",
      timeout: Math.max(1, deadline - Date.now()),
    });
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
  const taskIds = docker(["service", "ps", "--quiet", "--no-trunc", serviceName])
    .split(/\s+/)
    .filter(Boolean);
  if (taskIds.length === 0) return [];
  const tasks = taskInspectionsSchema.parse(
    JSON.parse(docker(["inspect", "--type", "task", ...taskIds])),
  );
  const observedIds = new Set(tasks.map((task) => task.ID));
  if (tasks.length !== taskIds.length || taskIds.some((id) => !observedIds.has(id))) {
    throw new Error(
      `${serviceName} task inspection did not return every task: ${taskIds.join(", ")}`,
    );
  }
  return tasks
    .filter((task) => !TERMINAL_TASK_STATES.has(task.Status.State))
    .map((task) => `${serviceName}: ${task.ID}=${task.Status.State}`);
}

export async function waitForMigrationQuiescence(
  stackName: string,
  deploymentMode: "rolling" | "maintenance",
): Promise<void> {
  if (!stackName.trim()) throw new Error("A stack name is required for migration quiescence.");
  const consumers =
    deploymentMode === "maintenance" ? [...MIGRATION_CONSUMERS, "web"] : MIGRATION_CONSUMERS;
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  let waiting: string[] = [];
  while (Date.now() < deadline) {
    waiting = consumers.flatMap((consumer) => inspectService(`${stackName}_${consumer}`, deadline));
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

const commandPath = process.argv[1];
if (commandPath && import.meta.url === pathToFileURL(commandPath).href) {
  const [stackName, deploymentMode, ...extra] = process.argv.slice(2);
  if (
    !stackName ||
    (deploymentMode !== "rolling" && deploymentMode !== "maintenance") ||
    extra.length > 0
  ) {
    throw new Error(
      "Usage: pnpm tsx scripts/wait-migration-quiescence.ts <stack-name> <rolling|maintenance>",
    );
  }
  await waitForMigrationQuiescence(stackName, deploymentMode);
}
