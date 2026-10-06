import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const eventName = requiredEnvironmentVariable("GITHUB_EVENT_NAME");
const event: unknown = JSON.parse(
  readFileSync(requiredEnvironmentVariable("GITHUB_EVENT_PATH"), "utf8"),
);
const outputPath = requiredEnvironmentVariable("GITHUB_OUTPUT");
const summaryPath = requiredEnvironmentVariable("GITHUB_STEP_SUMMARY");
const repository = requiredEnvironmentVariable("GITHUB_REPOSITORY");

if (eventName === "workflow_dispatch") {
  const request = z
    .object({
      inputs: z.object({
        image_tag: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/),
      }),
    })
    .parse(event);
  appendFileSync(outputPath, `image_tag=${request.inputs.image_tag}\ncommit_sha=\nci_run_id=\n`);
  appendFileSync(
    summaryPath,
    `Manual production image request: \`${request.inputs.image_tag}\`.\n`,
  );
} else if (eventName === "workflow_run") {
  const request = z
    .object({
      workflow_run: z.object({ conclusion: z.string().nullable() }),
    })
    .parse(event);
  if (request.workflow_run.conclusion !== "success") {
    const conclusion = request.workflow_run.conclusion ?? "unknown";
    appendFileSync(
      summaryPath,
      `Deployment cancelled: the triggering CI run concluded \`${conclusion}\`; production was not updated.\n`,
    );
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/actions/runs/${requiredEnvironmentVariable("GITHUB_RUN_ID")}/cancel`,
      ],
      { stdio: "inherit" },
    );
    // Keep this request non-successful even if cancellation is still being processed.
    process.exitCode = 1;
  } else {
    const response = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repository}/actions/workflows/ci.yml/runs`,
        "-f",
        "branch=main",
        "-f",
        "event=push",
        "-f",
        "status=success",
        "-F",
        "per_page=1",
        "--jq",
        ".workflow_runs[0] | if . == null then null else {id, head_sha} end",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const latestRun = z
      .object({
        id: z.number().int().positive(),
        head_sha: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .nullable()
      .parse(JSON.parse(response));
    if (!latestRun)
      throw new Error("No successful main CI run is available for production deployment");

    const imageTag = `sha-${latestRun.head_sha.slice(0, 7)}`;
    appendFileSync(
      outputPath,
      `image_tag=${imageTag}\ncommit_sha=${latestRun.head_sha}\nci_run_id=${latestRun.id}\n`,
    );
    appendFileSync(
      summaryPath,
      `Selected production release \`${latestRun.head_sha}\` (\`${imageTag}\`) from [successful CI](https://github.com/${repository}/actions/runs/${latestRun.id}).\n`,
    );
  }
} else {
  throw new Error(`Unsupported deployment event ${eventName}`);
}
