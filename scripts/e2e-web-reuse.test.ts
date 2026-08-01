import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const commandSchema = z.object({
  arguments: z.array(z.string()),
  command: z.string(),
});

describe("e2e-web-reuse", () => {
  it("uses the isolated E2E Compose project for dependencies and one-shot services", () => {
    const testDirectory = mkdtempSync(join(tmpdir(), "e2e-web-reuse-test-"));
    const binaryDirectory = join(testDirectory, "bin");
    const commandLogPath = join(testDirectory, "commands.jsonl");
    mkdirSync(binaryDirectory);

    writeFileSync(
      join(binaryDirectory, "pnpm"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify({
  command: "pnpm",
  arguments: process.argv.slice(2),
}) + "\\n");
if (process.argv.includes("ps")) {
  if (!process.argv.includes("--silent")) {
    process.stdout.write("> dofek@0.1.0 compose\\n> tsx scripts/compose-command.ts\\n");
  }
  process.stdout.write("one-shot-container\\n");
}
`,
    );
    writeFileSync(
      join(binaryDirectory, "docker"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify({
  command: "docker",
  arguments: process.argv.slice(2),
}) + "\\n");
if (process.argv[2] === "wait") process.stdout.write("0\\n");
`,
    );
    chmodSync(join(binaryDirectory, "pnpm"), 0o755);
    chmodSync(join(binaryDirectory, "docker"), 0o755);

    try {
      execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/e2e-web-reuse.ts"), "--up-only"],
        {
          env: {
            ...process.env,
            COMMAND_LOG_PATH: commandLogPath,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      execFileSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/e2e-web-reuse.ts")], {
        env: {
          ...process.env,
          COMMAND_LOG_PATH: commandLogPath,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/e2e-web-reuse.ts"), "--", "--spec", "cypress/e2e/review-stack.cy.ts"],
        {
          env: {
            ...process.env,
            COMMAND_LOG_PATH: commandLogPath,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const commands = readFileSync(commandLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => commandSchema.parse(JSON.parse(line)));
      const composeCommands = commands.filter(
        (command) => command.command === "pnpm" && command.arguments.includes("compose"),
      );

      expect(composeCommands).toHaveLength(22);
      expect(
        composeCommands.every((command) =>
          command.arguments
            .filter((argument) => argument !== "--silent")
            .join(" ")
            .startsWith("compose -- --project-suffix e2e -f docker-compose.e2e.yml"),
        ),
      ).toBe(true);
      const composeServices = composeCommands.map((command) => command.arguments.at(-1));
      expect(composeServices).toHaveLength(22);
      expect(composeServices).toEqual([
        "redpanda",
        "migrate",
        "migrate",
        "analytics",
        "analytics",
        "server",
        "redpanda",
        "migrate",
        "migrate",
        "analytics",
        "analytics",
        "server",
        "redpanda",
        "migrate",
        "migrate",
        "seed",
        "seed",
        "review-seed-clickhouse",
        "review-seed-clickhouse",
        "analytics",
        "analytics",
        "server",
      ]);
      expect(composeCommands.filter((command) => command.arguments.at(-1) === "seed")).toHaveLength(
        2,
      );
      expect(
        composeCommands.filter((command) => command.arguments.at(-1) === "review-seed-clickhouse"),
      ).toHaveLength(2);
      expect(
        composeCommands
          .filter(
            (command) =>
              command.arguments.includes("up") && command.arguments.at(-1) === "analytics",
          )
          .every((command) => command.arguments.includes("--no-deps")),
      ).toBe(true);
      expect(
        composeCommands
          .filter((command) => command.arguments.at(-1) === "server")
          .every((command) => command.arguments.includes("--no-deps")),
      ).toBe(true);
      const dockerCommands = commands.filter((command) => command.command === "docker");
      expect(dockerCommands).toHaveLength(8);
      expect(
        dockerCommands.every(
          (command) => command.arguments.join("\0") === "wait\0one-shot-container",
        ),
      ).toBe(true);
      expect(
        commands.filter(
          (command) => command.command === "pnpm" && command.arguments.includes("cypress"),
        ),
      ).toEqual([
        { command: "pnpm", arguments: ["exec", "cypress", "run"] },
        {
          command: "pnpm",
          arguments: ["exec", "cypress", "run", "--spec", "cypress/e2e/review-stack.cy.ts"],
        },
      ]);
    } finally {
      rmSync(testDirectory, { force: true, recursive: true });
    }
  });
});
