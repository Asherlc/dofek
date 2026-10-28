import { execFileSync } from "node:child_process";
import { z } from "zod";

const commitShaSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{40}$/)
  .toLowerCase();
const deploymentPageSchema = z.object({
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      deployments: z.object({
        nodes: z.array(
          z.object({
            databaseId: z.number().int().positive(),
            commitOid: commitShaSchema,
            environment: z.literal("testflight"),
            task: z.string(),
            latestStatus: z
              .object({
                state: z.enum([
                  "ERROR",
                  "FAILURE",
                  "INACTIVE",
                  "IN_PROGRESS",
                  "QUEUED",
                  "PENDING",
                  "SUCCESS",
                  "WAITING",
                ]),
              })
              .nullable(),
          }),
        ),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().min(1).nullable(),
        }),
      }),
    }),
  }),
});
const deploymentHistoryQuery = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    deployments(environments: ["testflight"], first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { databaseId environment task commitOid latestStatus { state } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const nativeInputPattern =
  /^(pnpm-lock\.yaml$|patches\/|packages\/mobile\/(package\.json$|app\.json$|app\.config\.(js|ts|mjs|cjs)$|fingerprint\.config\.js$|\.fingerprintignore$|\.gitignore$|assets\/|certs\/certificate\.pem$|build\/|plugins\/|targets\/|native\/|modules\/[^/]+\/(expo-module\.config\.json$|ios\/)))/;

export function requiresTestFlightUpload(
  repository: string,
  commitSha: string,
  force = false,
): boolean {
  const normalizedSha = commitShaSchema.parse(commitSha);
  execFileSync("git", ["cat-file", "-e", `${normalizedSha}^{commit}`], { stdio: "inherit" });
  const baseline = findLastTestFlightUpload(repository);
  if (force) return true;
  if (baseline === null) return true;
  if (baseline === normalizedSha) return false;
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", baseline, normalizedSha, "--"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return changedPaths.split("\0").some((path) => nativeInputPattern.test(path));
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
  const [owner, name] = z
    .tuple([z.string().min(1), z.string().min(1)])
    .parse(repository.split("/"));
  let after: string | null = null;
  for (;;) {
    const response: z.infer<typeof deploymentPageSchema> = deploymentPageSchema.parse(
      githubApi(["graphql", "--input", "-"], {
        query: deploymentHistoryQuery,
        variables: { owner, name, after },
      }),
    );
    const { nodes, pageInfo } = response.data.repository.deployments;
    for (const deployment of nodes) {
      if (deployment.task !== "testflight-upload") continue;
      const state = deployment.latestStatus?.state;
      if (state === "INACTIVE") continue;
      if (state === "SUCCESS") return deployment.commitOid;
      throw new Error(
        `Unresolved TestFlight upload deployment ${deployment.databaseId} (${deployment.commitOid}, ${state ?? "no status"}). Check the original upload run and App Store Connect before retrying publication.`,
      );
    }
    if (!pageInfo.hasNextPage) return null;
    if (!pageInfo.endCursor || pageInfo.endCursor === after) {
      throw new Error("TestFlight deployment history cursor did not advance");
    }
    after = pageInfo.endCursor;
  }
}

const uploadDeploymentSchema = z.object({
  id: z.number().int().positive(),
  sha: commitShaSchema,
  environment: z.literal("testflight"),
  task: z.literal("testflight-upload"),
  payload: z.object({ build_number: z.string(), run_url: z.url() }),
});

function validateUploadEvidence(commitSha: string, buildNumber: string, runUrl: string): string {
  const normalizedSha = commitShaSchema.parse(commitSha);
  z.string().regex(/^\d+$/).parse(buildNumber);
  z.url().parse(runUrl);
  return normalizedSha;
}

function verifyUploadDeployment(
  value: unknown,
  commitSha: string,
  buildNumber: string,
  runUrl: string,
) {
  const deployment = uploadDeploymentSchema.parse(value);
  if (
    deployment.sha !== commitSha ||
    deployment.payload.build_number !== buildNumber ||
    deployment.payload.run_url !== runUrl
  ) {
    throw new Error(
      "TestFlight deployment does not match the original upload source, build number and run",
    );
  }
  return deployment;
}

/** Rechecks ambiguity inside every uploader attempt, immediately before the upload side effect. */
export function prepareTestFlightUpload(
  repository: string,
  commitSha: string,
  buildNumber: string,
  runUrl: string,
): number {
  const normalizedSha = validateUploadEvidence(commitSha, buildNumber, runUrl);
  findLastTestFlightUpload(repository);
  const deployment = verifyUploadDeployment(
    githubApi(["--method", "POST", `repos/${repository}/deployments`, "--input", "-"], {
      ref: normalizedSha,
      environment: "testflight",
      task: "testflight-upload",
      auto_merge: false,
      required_contexts: [],
      production_environment: false,
      payload: { build_number: buildNumber, run_url: runUrl },
    }),
    normalizedSha,
    buildNumber,
    runUrl,
  );
  z.object({ state: z.literal("pending") }).parse(
    githubApi(
      [
        "--method",
        "POST",
        `repos/${repository}/deployments/${deployment.id}/statuses`,
        "--input",
        "-",
      ],
      {
        state: "pending",
        auto_inactive: false,
        log_url: runUrl,
        description: `TestFlight build ${buildNumber} awaiting upload`,
      },
    ),
  );
  return deployment.id;
}

/** Finalizes only the original intent after its signed archive upload succeeds. */
export function recordTestFlightUpload(
  repository: string,
  deploymentId: number,
  commitSha: string,
  buildNumber: string,
  runUrl: string,
): void {
  const normalizedSha = validateUploadEvidence(commitSha, buildNumber, runUrl);
  z.number().int().positive().parse(deploymentId);
  const deployment = verifyUploadDeployment(
    githubApi(["--method", "GET", `repos/${repository}/deployments/${deploymentId}`]),
    normalizedSha,
    buildNumber,
    runUrl,
  );
  if (deployment.id !== deploymentId)
    throw new Error("TestFlight deployment ID does not match the original upload intent");
  z.object({ state: z.literal("success") }).parse(
    githubApi(
      [
        "--method",
        "POST",
        `repos/${repository}/deployments/${deploymentId}/statuses`,
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
