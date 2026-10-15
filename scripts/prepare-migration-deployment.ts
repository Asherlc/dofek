import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { chooseMigrationDeployment } from "./migration-deployment.ts";

const imagePrefix = "ghcr.io/asherlc/dofek:";
const imageSchema = z
  .string()
  .regex(/^ghcr\.io\/asherlc\/dofek:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:@sha256:[a-f0-9]{64})?$/);
const argumentsSchema = z.tuple([imageSchema, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)]);
const maintenanceLabel = "dofek.migration-maintenance-target";
const deployedServiceSchema = z.object({
  Spec: z.object({
    Labels: z
      .object({
        [maintenanceLabel]: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .nullish(),
      })
      .nullish(),
    TaskTemplate: z.object({ ContainerSpec: z.object({ Image: imageSchema }) }),
  }),
});

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
  const [requestedImage, stackName] = argumentsSchema.parse(process.argv.slice(2));
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
    const [service] = z
      .tuple([deployedServiceSchema])
      .parse(JSON.parse(docker(["service", "inspect", webService])));
    deployedImage = service.Spec.TaskTemplate.ContainerSpec.Image;
    maintenanceBoundary = service.Spec.Labels?.[maintenanceLabel] ?? null;
  }
  if (deployedImage !== null && !deployedImage.includes("@sha256:"))
    throw new Error("The deployed web image must include its immutable sha256 digest.");

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
    `mode=${decision.mode}\npre_migration_image_tag=${(deployedImage ?? requestedImage).slice(imagePrefix.length)}\nmaintenance_boundary=${decision.targetMigrationTag}\n`,
  );
}

await main();
