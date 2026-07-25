import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const commandArgumentsSchema = z.array(z.array(z.string()));

describe("run-tests", () => {
  it("forwards a requested integration file without pnpm's argument separator", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "run-tests-test-"));
    const binaryDirectory = join(workspaceDirectory, "bin");
    const commandLogPath = join(workspaceDirectory, "pnpm-calls.jsonl");
    mkdirSync(binaryDirectory);
    writeFileSync(
      join(workspaceDirectory, ".env.local"),
      [
        "CLICKHOUSE_URL=http://default:health@127.0.0.1:18123",
        "DATABASE_URL=postgres://health:health@127.0.0.1:15432/health",
        "REDPANDA_BROKERS=127.0.0.1:19092",
        "REDIS_URL=redis://127.0.0.1:16379",
        "",
      ].join("\n"),
    );

    const fakePnpmPath = join(binaryDirectory, "pnpm");
    writeFileSync(
      fakePnpmPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    chmodSync(fakePnpmPath, 0o755);

    try {
      execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/run-tests.ts"), "integration", "--", "src/db/db.integration.test.ts"],
        {
          cwd: workspaceDirectory,
          env: {
            ...process.env,
            COMMAND_LOG_PATH: commandLogPath,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const commandArguments = commandArgumentsSchema.parse(
        readFileSync(commandLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );

      expect(commandArguments).toEqual([
        ["compose:up"],
        ["exec", "vitest", "run", "--project", "integration", "src/db/db.integration.test.ts"],
      ]);
    } finally {
      rmSync(workspaceDirectory, { force: true, recursive: true });
    }
  });
});
