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

const dockerCallSchema = z.array(z.string());
const dockerInvocationSchema = z.object({
  arguments: dockerCallSchema,
  composeFile: z.string(),
  composeProjectName: z.string(),
  workingDirectory: z.string(),
});

describe("conductor-archive", () => {
  it("removes only the archived workspace Compose resources and named volumes", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "conductor-archive-test-"));
    const physicalWorkspaceDirectory = realpathSync(workspaceDirectory);
    const binaryDirectory = join(workspaceDirectory, "bin");
    const dockerLogPath = join(workspaceDirectory, "docker-calls.jsonl");
    mkdirSync(binaryDirectory);
    const composeProjectName = basename(physicalWorkspaceDirectory);
    writeFileSync(
      join(workspaceDirectory, ".env.local"),
      `COMPOSE_PROJECT_NAME=${composeProjectName}\n`,
    );
    writeFileSync(join(workspaceDirectory, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(workspaceDirectory, "docker-compose.e2e.yml"), "services: {}\n");

    const fakeDockerPath = join(binaryDirectory, "docker");
    writeFileSync(
      fakeDockerPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const arguments = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG_PATH, JSON.stringify({
  arguments,
  composeFile: process.env.COMPOSE_FILE,
  composeProjectName: process.env.COMPOSE_PROJECT_NAME,
  workingDirectory: process.env.PWD,
}) + "\\n");
if (arguments.includes("config")) process.stdout.write('{"name":"${composeProjectName}"}');
if (arguments[0] === "container" && arguments[1] === "ls") {
  const filter = arguments.at(-1);
  process.stdout.write(filter.endsWith("-e2e") ? "e2e-container-id\\n" : "container-id\\n");
}
`,
    );
    chmodSync(fakeDockerPath, 0o755);

    try {
      execFileSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/conductor-archive.ts")], {
        cwd: workspaceDirectory,
        env: {
          ...process.env,
          DOCKER_LOG_PATH: dockerLogPath,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          COMPOSE_FILE: "/stale/conductor/workspace/docker-compose.yml",
          COMPOSE_PROJECT_NAME: "stale-workspace",
          PWD: "/stale/conductor/workspace",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const dockerCalls = readFileSync(dockerLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => dockerInvocationSchema.parse(JSON.parse(line)));
      const composeCalls = dockerCalls.filter(
        (invocation) => invocation.arguments[0] === "compose",
      );
      const composeDownCalls = composeCalls.filter((invocation) =>
        invocation.arguments.includes("down"),
      );

      expect(composeCalls).toHaveLength(3);
      expect(
        composeCalls.every((invocation) =>
          invocation.arguments.includes(physicalWorkspaceDirectory),
        ),
      ).toBe(true);
      expect(
        composeCalls.every(
          (invocation) => invocation.workingDirectory === physicalWorkspaceDirectory,
        ),
      ).toBe(true);
      expect(composeCalls.map((invocation) => invocation.composeProjectName)).toEqual([
        composeProjectName,
        composeProjectName,
        `${composeProjectName}-e2e`,
      ]);
      expect(
        composeCalls.every(
          (invocation) =>
            invocation.composeFile === join(physicalWorkspaceDirectory, "docker-compose.yml"),
        ),
      ).toBe(true);
      expect(composeDownCalls).toHaveLength(2);
      expect(
        composeDownCalls.map((invocation) => {
          const projectNameIndex = invocation.arguments.indexOf("--project-name");
          return invocation.arguments[projectNameIndex + 1];
        }),
      ).toEqual([composeProjectName, `${composeProjectName}-e2e`]);
      expect(
        composeDownCalls.every((invocation) => invocation.arguments.includes("--remove-orphans")),
      ).toBe(true);
      expect(
        composeDownCalls.every((invocation) => invocation.arguments.includes("--volumes")),
      ).toBe(true);
      expect(dockerCalls.map((invocation) => invocation.arguments)).toContainEqual([
        "container",
        "rm",
        "--force",
        "container-id",
      ]);
      expect(dockerCalls.map((invocation) => invocation.arguments)).toContainEqual([
        "container",
        "rm",
        "--force",
        "e2e-container-id",
      ]);
    } finally {
      rmSync(workspaceDirectory, { force: true, recursive: true });
    }
  });
});
