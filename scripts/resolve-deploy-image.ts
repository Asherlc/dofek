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
  const isolatedInspection = ["--candidate-only", "--resolve-source-only"].includes(
    process.argv.at(-1) ?? "",
  );
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      ...(isolatedInspection ? { DOCKER_HOST: "" } : {}),
    },
  }).trim();
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  const sourceOnly = arguments_.at(-1) === "--resolve-source-only";
  if (sourceOnly) arguments_.pop();
  const candidateOnly = arguments_.at(-1) === "--candidate-only";
  if (candidateOnly) arguments_.pop();
  const outputFile = z.string().min(1).parse(process.env.GITHUB_OUTPUT);
  if (sourceOnly) {
    const [requestedImage] = z.tuple([deployImageSchema]).parse(arguments_);
    const manifest = z
      .object({ digest: imageDigestSchema })
      .parse(
        JSON.parse(
          docker(
            "buildx",
            "imagetools",
            "inspect",
            requestedImage,
            "--format",
            "{{json .Manifest}}",
          ),
        ),
      );
    const imageRef = `${imageRepository(requestedImage)}@${manifest.digest}`;
    docker("pull", "--platform", "linux/arm64", imageRef);
    const imageEnvironment = z
      .array(z.string())
      .parse(JSON.parse(docker("image", "inspect", imageRef, "--format", "{{json .Config.Env}}")));
    const imageLabels = z
      .record(z.string(), z.string())
      .parse(
        JSON.parse(docker("image", "inspect", imageRef, "--format", "{{json .Config.Labels}}")),
      );
    const sentryRelease = imageEnvironment
      .find((value) => value.startsWith("SENTRY_RELEASE="))
      ?.slice("SENTRY_RELEASE=".length);
    const sourceSha = sourceCommitSchema.parse(imageLabels["org.opencontainers.image.revision"]);
    if (sentryRelease !== sourceSha) {
      throw new Error("Image OCI revision label does not match SENTRY_RELEASE");
    }
    appendFileSync(outputFile, `image_ref=${imageRef}\nsource_sha=${sourceSha}\n`);
    console.log(`Resolved manual image source ${sourceSha} from immutable image ${imageRef}`);
    return;
  }
  const [requestedImage, expectedCommit, webServiceName] = z
    .tuple([
      deployImageSchema,
      sourceCommitSchema,
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .parse(arguments_);
  const manifest = z
    .object({ digest: imageDigestSchema })
    .parse(
      JSON.parse(
        docker("buildx", "imagetools", "inspect", requestedImage, "--format", "{{json .Manifest}}"),
      ),
    );
  const imageRef = `${imageRepository(requestedImage)}@${manifest.digest}`;

  let preMigrationImageRef = imageRef;
  if (!candidateOnly) {
    // List must succeed before absence can mean a first deployment.
    const services = docker("service", "ls", "--format", "{{.Name}}").split("\n");
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
  }

  docker("pull", ...(candidateOnly ? ["--platform", "linux/arm64"] : []), imageRef);
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
    candidateOnly
      ? `Validated candidate deployment image ${imageRef}`
      : `Validated deployment image ${imageRef}; pre-migration image ${preMigrationImageRef}`,
  );
}

main();
