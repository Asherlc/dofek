import { execFileSync } from "node:child_process";
import { z } from "zod";

const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentSchema = z.object({
  id: z.number().int().positive(),
  sha: commitShaSchema,
  created_at: z.iso.datetime(),
  environment: z.literal("testflight"),
  task: z.literal("testflight-upload"),
});
const statusSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.iso.datetime(),
  state: z.enum(["error", "failure", "inactive", "in_progress", "queued", "pending", "success"]),
});
const nativeInputPattern =
  /^(pnpm-lock\.yaml$|patches\/|packages\/mobile\/(package\.json$|app\.json$|app\.config\.(js|ts|mjs|cjs)$|fingerprint\.config\.js$|\.fingerprintignore$|\.gitignore$|assets\/|certs\/certificate\.pem$|build\/|plugins\/|targets\/|native\/|modules\/[^/]+\/(expo-module\.config\.json$|ios\/)))/;

export function requiresTestFlightUpload(
  repository: string,
  commitSha: string,
  force = false,
): boolean {
  commitShaSchema.parse(commitSha);
  execFileSync("git", ["cat-file", "-e", `${commitSha}^{commit}`], { stdio: "inherit" });
  if (force) return true;
  const baseline = findLastTestFlightUpload(repository);
  if (baseline === null) return true;
  if (baseline === commitSha) return false;
  const changedPaths = execFileSync("git", ["diff", "--name-only", baseline, commitSha, "--"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return changedPaths.split("\n").some((path) => nativeInputPattern.test(path));
}

function githubApi(arguments_: string[], body?: unknown): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", ...arguments_], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      input: JSON.stringify(body),
    }),
  );
}

/** Successful upload receipts are independent of the workflow that called the publisher. */
function findLastTestFlightUpload(repository: string): string | null {
  const deployments = z
    .array(z.array(deploymentSchema))
    .parse(
      githubApi([
        "--method",
        "GET",
        `repos/${repository}/deployments`,
        "-f",
        "environment=testflight",
        "-f",
        "task=testflight-upload",
        "-F",
        "per_page=100",
        "--paginate",
        "--slurp",
      ]),
    )
    .flat()
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
  for (const deployment of deployments) {
    const statuses = z
      .array(z.array(statusSchema))
      .parse(
        githubApi([
          "--method",
          "GET",
          `repos/${repository}/deployments/${deployment.id}/statuses`,
          "-F",
          "per_page=100",
          "--paginate",
          "--slurp",
        ]),
      );
    const latestStatus = statuses
      .flat()
      .sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id,
      )[0];
    if (latestStatus?.state === "success") return deployment.sha;
  }
  return null;
}

/** Called only after the signed archive's upload command succeeds. */
export function recordTestFlightUpload(
  repository: string,
  commitSha: string,
  buildNumber: string,
  runUrl: string,
): void {
  commitShaSchema.parse(commitSha);
  z.string().regex(/^\d+$/).parse(buildNumber);
  z.url().parse(runUrl);
  const deployment = z.object({ id: z.number().int().positive(), sha: commitShaSchema }).parse(
    githubApi(["--method", "POST", `repos/${repository}/deployments`, "--input", "-"], {
      ref: commitSha,
      environment: "testflight",
      task: "testflight-upload",
      auto_merge: false,
      required_contexts: [],
      production_environment: false,
      payload: { build_number: buildNumber },
    }),
  );
  if (deployment.sha !== commitSha) {
    throw new Error(`TestFlight upload receipt returned a different commit ${deployment.sha}`);
  }
  z.object({ state: z.literal("success") }).parse(
    githubApi(
      [
        "--method",
        "POST",
        `repos/${repository}/deployments/${deployment.id}/statuses`,
        "--input",
        "-",
      ],
      {
        state: "success",
        auto_inactive: false,
        log_url: runUrl,
        description: `TestFlight build ${buildNumber} uploaded successfully`,
      },
    ),
  );
}
