import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const dockerInvocationSchema = z.object({
  arguments: z.array(z.string()),
  composeFile: z.string(),
  composeProjectName: z.string(),
  workingDirectory: z.string(),
});

interface CapturedInvocation {
  invocation: z.infer<typeof dockerInvocationSchema>;
  physicalWorkspaceDirectory: string;
}

function captureInvocation(composeArguments: string[]): CapturedInvocation {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), "compose-command-test-"));
  const physicalWorkspaceDirectory = realpathSync(workspaceDirectory);
  const binaryDirectory = join(workspaceDirectory, "bin");
  const dockerLogPath = join(workspaceDirectory, "docker-call.json");
  mkdirSync(binaryDirectory);
  writeFileSync(join(workspaceDirectory, ".env.local"), "POSTGRES_PORT=15432\n");
  writeFileSync(join(workspaceDirectory, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(workspaceDirectory, "docker-compose.e2e.yml"), "services: {}\n");

  const fakeDockerPath = join(binaryDirectory, "docker");
  writeFileSync(
    fakeDockerPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.DOCKER_LOG_PATH, JSON.stringify({
  arguments: process.argv.slice(2),
  composeFile: process.env.COMPOSE_FILE,
  composeProjectName: process.env.COMPOSE_PROJECT_NAME,
  workingDirectory: process.env.PWD,
}));
`,
  );
  chmodSync(fakeDockerPath, 0o755);

  try {
    execFileSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/compose-command.ts"), "--", ...composeArguments],
      {
        cwd: workspaceDirectory,
        env: {
          ...process.env,
          COMPOSE_FILE: "/stale/conductor/workspace/docker-compose.yml",
          COMPOSE_PROJECT_NAME: "stale-workspace",
          DOCKER_LOG_PATH: dockerLogPath,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          PWD: "/stale/conductor/workspace",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return {
      invocation: dockerInvocationSchema.parse(JSON.parse(readFileSync(dockerLogPath, "utf8"))),
      physicalWorkspaceDirectory,
    };
  } finally {
    rmSync(workspaceDirectory, { force: true, recursive: true });
  }
}

describe("compose-command", () => {
  it("pins Compose to the physical workspace when inherited environment paths are stale", () => {
    const { invocation, physicalWorkspaceDirectory } = captureInvocation(["ps", "db"]);
    const composeFilePath = join(physicalWorkspaceDirectory, "docker-compose.yml");

    expect(invocation.arguments).toEqual([
      "compose",
      "--project-name",
      basename(physicalWorkspaceDirectory),
      "--project-directory",
      physicalWorkspaceDirectory,
      "--env-file",
      join(physicalWorkspaceDirectory, ".env.local"),
      "ps",
      "db",
    ]);
    expect(invocation.workingDirectory).toBe(physicalWorkspaceDirectory);
    expect(invocation.composeProjectName).toBe(basename(physicalWorkspaceDirectory));
    expect(invocation.composeFile).toBe(composeFilePath);
  });

  it("uses an isolated project name and consumes the requested project suffix", () => {
    const { invocation, physicalWorkspaceDirectory } = captureInvocation([
      "--project-suffix",
      "e2e",
      "-f",
      "docker-compose.e2e.yml",
      "ps",
      "db",
    ]);
    const isolatedProjectName = `${basename(physicalWorkspaceDirectory)}-e2e`;

    expect(invocation.arguments).toEqual([
      "compose",
      "--project-name",
      isolatedProjectName,
      "--project-directory",
      physicalWorkspaceDirectory,
      "--env-file",
      join(physicalWorkspaceDirectory, ".env.local"),
      "-f",
      "docker-compose.e2e.yml",
      "ps",
      "db",
    ]);
    expect(invocation.composeProjectName).toBe(isolatedProjectName);
  });
});
