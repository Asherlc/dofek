import { spawnSync } from "node:child_process";
import { z } from "zod";

/** Stock docker ps Go template: one JSON object per Compose container row. */
const composeContainerInventoryFormat =
  '{"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}},"directory":{{json (.Label "com.docker.compose.project.working_dir")}},"configFiles":{{json (.Label "com.docker.compose.project.config_files")}}}';

const composeContainerRowSchema = z.object({
  name: z.string().min(1),
  project: z.string().min(1),
  directory: z.string().default(""),
  configFiles: z.string().default(""),
});

export type ComposeContainerRow = z.infer<typeof composeContainerRowSchema>;

export function listComposeContainers(): ComposeContainerRow[] {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      composeContainerInventoryFormat,
    ],
    {
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const failure = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? "unknown"}`;
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `docker ps Compose inventory exited with ${failure}${detail ? `: ${detail}` : ""}`,
    );
  }

  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    return [];
  }

  const rows: ComposeContainerRow[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `docker ps Compose inventory produced invalid JSON on line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const validated = composeContainerRowSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `docker ps Compose inventory row failed validation on line ${index + 1}: ${validated.error.message}`,
      );
    }
    rows.push(validated.data);
  }
  return rows;
}
