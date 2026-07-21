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

describe("compose-command", () => {
  it("pins Compose to the physical workspace when inherited environment paths are stale", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "compose-command-test-"));
    const physicalWorkspaceDirectory = realpathSync(workspaceDirectory);
    const binaryDirectory = join(workspaceDirectory, "bin");
    const dockerLogPath = join(workspaceDirectory, "docker-call.json");
    mkdirSync(binaryDirectory);
    writeFileSync(join(workspaceDirectory, ".env.local"), "POSTGRES_PORT=15432\n");
    writeFileSync(join(workspaceDirectory, "docker-compose.yml"), "services: {}\n");

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
        [resolve("scripts/compose-command.ts"), "--", "ps", "db"],
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

      const invocation = dockerInvocationSchema.parse(
        JSON.parse(readFileSync(dockerLogPath, "utf8")),
      );
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
    } finally {
      rmSync(workspaceDirectory, { force: true, recursive: true });
    }
  });
});
