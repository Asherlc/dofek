import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import {
  deployImageSchema,
  imageDigestSchema,
  imageRepository,
  immutableImageReference,
} from "./deploy-image-reference.ts";

const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function main(): void {
  const [requestedImage, expectedCommit, webServiceName] = z
    .tuple([
      deployImageSchema,
      sourceCommitSchema,
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .parse(process.argv.slice(2));
  const outputFile = z.string().min(1).parse(process.env.GITHUB_OUTPUT);
  const manifest = z
    .object({ digest: imageDigestSchema })
    .parse(
      JSON.parse(
        docker("buildx", "imagetools", "inspect", requestedImage, "--format", "{{json .Manifest}}"),
      ),
    );
  const imageRef = `${imageRepository(requestedImage)}@${manifest.digest}`;

  // List must succeed before absence can mean a first deployment.
  const services = docker("service", "ls", "--format", "{{.Name}}").split("\n");
  let preMigrationImageRef = imageRef;
  if (services.includes(webServiceName)) {
    preMigrationImageRef = docker(
      "service",
      "inspect",
      webServiceName,
      "--format",
      "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    );
    immutableImageReference(preMigrationImageRef);
    if (imageRepository(preMigrationImageRef) !== imageRepository(requestedImage)) {
      throw new Error(
        `Existing service ${webServiceName} must declare an immutable image in ${imageRepository(requestedImage)}; found ${preMigrationImageRef}`,
      );
    }
  }

  docker("pull", imageRef);
  const imageEnvironment = z
    .array(z.string())
    .parse(JSON.parse(docker("image", "inspect", imageRef, "--format", "{{json .Config.Env}}")));
  const sentryRelease = imageEnvironment
    .find((value) => value.startsWith("SENTRY_RELEASE="))
    ?.slice("SENTRY_RELEASE=".length);
  if (sentryRelease !== expectedCommit) {
    throw new Error(
      `Checked-out commit ${expectedCommit} does not match image SENTRY_RELEASE ${sentryRelease ?? "(missing)"}; dispatch the workflow from the image's source commit.`,
    );
  }
  appendFileSync(
    outputFile,
    `image_ref=${imageRef}\npre_migration_image_ref=${preMigrationImageRef}\nsentry_release=${sentryRelease}\n`,
  );
  console.log(
    `Validated deployment image ${imageRef}; pre-migration image ${preMigrationImageRef}`,
  );
}

main();
