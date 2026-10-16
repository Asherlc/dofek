import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { imageRepository, immutableImageReference } from "./deploy-image-reference.ts";
import { chooseMigrationDeployment } from "./migration-deployment.ts";

const argumentsSchema = z.tuple([
  z.string(),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  z.string(),
]);
const maintenanceLabel = "dofek.migration-maintenance-target";
const deployedServiceSchema = z.object({
  image: z.string(),
  labels: z
    .object({
      [maintenanceLabel]: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .nullish(),
    })
    .nullish(),
});

function appImageReference(image: string): string {
  const reference = immutableImageReference(image);
  if (imageRepository(reference) !== "ghcr.io/asherlc/dofek")
    throw new Error("Migration inspection requires an immutable ghcr.io/asherlc/dofek image.");
  return reference;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function withInspectionContainer(image: string, inspect: (container: string) => void): void {
  const container = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(docker(["create", image]));
  try {
    inspect(container);
  } finally {
    docker(["rm", container]);
  }
}

async function main(): Promise<void> {
  const [requestedReference, stackName, expectedReference] = argumentsSchema.parse(
    process.argv.slice(2),
  );
  const requestedImage = appImageReference(requestedReference);
  const expectedImage = appImageReference(expectedReference);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");

  const webService = `${stackName}_web`;
  const services = docker([
    "service",
    "ls",
    "--filter",
    `name=${webService}`,
    "--format",
    "{{.Name}}",
  ])
    .split("\n")
    .filter(Boolean);
  let deployedImage: string | null = null;
  let maintenanceBoundary: string | null = null;
  if (services.includes(webService)) {
    const service = deployedServiceSchema.parse(
      JSON.parse(
        docker([
          "service",
          "inspect",
          webService,
          "--format",
          '{"image":{{json .Spec.TaskTemplate.ContainerSpec.Image}},"labels":{{json .Spec.Labels}}}',
        ]),
      ),
    );
    if (appImageReference(service.image) !== expectedImage)
      throw new Error("The deployed web image changed after release selection.");
    deployedImage = expectedImage;
    maintenanceBoundary = service.labels?.[maintenanceLabel] ?? null;
  } else if (expectedImage !== requestedImage) {
    throw new Error("The deployed web service changed after release selection.");
  }

  const directory = mkdtempSync(join(tmpdir(), "dofek-migration-deployment-"));
  let decision: Awaited<ReturnType<typeof chooseMigrationDeployment>>;
  try {
    const targetDirectory = join(directory, "requested");
    mkdirSync(targetDirectory);
    withInspectionContainer(requestedImage, (container) => {
      docker(["cp", `${container}:/app/drizzle/.`, targetDirectory]);
    });
    let deployedJournal: unknown = null;
    if (deployedImage !== null) {
      const journalPath = join(directory, "deployed-journal.json");
      withInspectionContainer(deployedImage, (container) => {
        docker(["cp", `${container}:/app/drizzle/meta/_journal.json`, journalPath]);
      });
      deployedJournal = JSON.parse(readFileSync(journalPath, "utf8"));
      if (deployedJournal === null)
        throw new Error("The deployed migration journal cannot be null.");
    }
    decision = await chooseMigrationDeployment(
      targetDirectory,
      deployedJournal,
      maintenanceBoundary,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  appendFileSync(
    outputPath,
    `mode=${decision.mode}\nmaintenance_boundary=${decision.targetMigrationTag}\n`,
  );
}

await main();
