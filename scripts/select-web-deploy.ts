import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";

const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

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
      workflow_run: z.object({
        conclusion: z.string().nullable(),
        head_sha: commitShaSchema,
      }),
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
    const mainCommits = z.array(commitShaSchema).parse(
      execFileSync("git", ["rev-list", "--first-parent", "origin/main"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
        .trim()
        .split("\n"),
    );
    const triggeringIndex = mainCommits.indexOf(request.workflow_run.head_sha);
    if (triggeringIndex === -1) {
      throw new Error(
        `Triggering CI commit ${request.workflow_run.head_sha} is not in the checked-out main history`,
      );
    }
    const successfulRunSchema = z.object({
      id: z.number().int().positive(),
      head_sha: commitShaSchema,
      head_branch: z.literal("main"),
      event: z.literal("push"),
      conclusion: z.literal("success"),
    });
    let latestRun: z.infer<typeof successfulRunSchema> | null = null;
    for (const commit of mainCommits.slice(0, triggeringIndex + 1)) {
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
          "-f",
          `head_sha=${commit}`,
          "-F",
          "per_page=1",
          "--jq",
          ".workflow_runs[0] | if . == null then null else {id, head_sha, head_branch, event, conclusion} end",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      const run = successfulRunSchema.nullable().parse(JSON.parse(response));
      if (run) {
        if (run.head_sha !== commit) {
          throw new Error(`CI lookup for ${commit} returned a different commit ${run.head_sha}`);
        }
        latestRun = run;
        break;
      }
    }
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
