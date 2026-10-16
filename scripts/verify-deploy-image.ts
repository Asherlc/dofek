import { execFileSync } from "node:child_process";
import { z } from "zod";
import { immutableImageReference } from "./deploy-image-reference.ts";

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const [expectedImage, service] = z
  .tuple([z.string(), z.string().min(1)])
  .parse(process.argv.slice(2));
const expected = immutableImageReference(expectedImage);
const desired = docker(
  "service",
  "inspect",
  service,
  "--format",
  "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
);
if (immutableImageReference(desired) !== expected) {
  throw new Error(`${service} desired image ${desired} does not match ${expected}`);
}
const taskIds = docker(
  "service",
  "ps",
  service,
  "--filter",
  "desired-state=running",
  "--format",
  "{{.ID}}",
)
  .split("\n")
  .filter(Boolean);
const desiredReplicas = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative())
  .parse(docker("service", "inspect", service, "--format", "{{.Spec.Mode.Replicated.Replicas}}"));
if (taskIds.length !== desiredReplicas) {
  throw new Error(`${service} requires ${desiredReplicas} running tasks; found ${taskIds.length}`);
}
for (const taskId of taskIds) {
  const task = z
    .object({
      image: z.string(),
      state: z.string(),
    })
    .parse(
      JSON.parse(
        docker(
          "inspect",
          "--type",
          "task",
          taskId,
          "--format",
          '{"image":{{json .Spec.ContainerSpec.Image}},"state":{{json .Status.State}}}',
        ),
      ),
    );
  if (task.state !== "running" || immutableImageReference(task.image) !== expected) {
    throw new Error(
      `${service} task ${taskId} is ${task.state} on ${task.image}, expected running on ${expected}`,
    );
  }
}
console.log(
  `Verified ${service} desired image and ${taskIds.length} running task images: ${expected}`,
);
