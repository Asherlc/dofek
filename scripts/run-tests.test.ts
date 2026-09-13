import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const commandArgumentsSchema = z.array(z.array(z.string()));

describe("run-tests", () => {
  it.each(["all", "changed"] as const)(
    "keeps the dedicated PeerDB project out of the ordinary %s tier",
    (mode) => {
      const workspaceDirectory = mkdtempSync(join(tmpdir(), "run-tests-all-test-"));
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
        execFileSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/run-tests.ts"), mode], {
          cwd: workspaceDirectory,
          env: {
            ...process.env,
            COMMAND_LOG_PATH: commandLogPath,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const commandArguments = commandArgumentsSchema.parse(
          readFileSync(commandLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );

        expect(commandArguments).toEqual([
          ["compose:up"],
          [
            "exec",
            "vitest",
            "run",
            "--project",
            "unit",
            "--project",
            "mobile",
            "--project",
            "integration",
            ...(mode === "changed" ? ["--changed", "origin/main"] : []),
          ],
        ]);
      } finally {
        rmSync(workspaceDirectory, { force: true, recursive: true });
      }
    },
  );

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

  it("runs the PeerDB integration project with the full Compose stack and cleans it up", () => {
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "run-tests-peerdb-test-"));
    const binaryDirectory = join(workspaceDirectory, "bin");
    const commandLogPath = join(workspaceDirectory, "pnpm-calls.jsonl");
    mkdirSync(binaryDirectory);
    writeFileSync(
      join(workspaceDirectory, ".env.peerdb-integration.local"),
      [
        "CLICKHOUSE_URL=http://default:health@127.0.0.1:18123",
        "DATABASE_URL=postgres://health:health@127.0.0.1:15432/health",
        "REDPANDA_BROKERS=127.0.0.1:19092",
        "REDIS_URL=redis://127.0.0.1:16379",
        "POSTGRES_PASSWORD=health",
        "PEERDB_CDC_HOST=127.0.0.1",
        "PEERDB_CDC_PORT=13000",
        "PEERDB_UI_PORT=13001",
        "",
      ].join("\n"),
    );

    const fakePnpmPath = join(binaryDirectory, "pnpm");
    writeFileSync(
      fakePnpmPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.COMMAND_LOG_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("vitest")) {
  appendFileSync(process.env.ENVIRONMENT_LOG_PATH, JSON.stringify({
    PEERDB_CDC_HOST: process.env.PEERDB_CDC_HOST,
    PEERDB_CDC_PORT: process.env.PEERDB_CDC_PORT,
    PEERDB_UI_PORT: process.env.PEERDB_UI_PORT,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
  }));
}
`,
    );
    chmodSync(fakePnpmPath, 0o755);

    try {
      execFileSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("scripts/run-tests.ts"), "peerdb-integration"],
        {
          cwd: workspaceDirectory,
          env: {
            ...process.env,
            COMMAND_LOG_PATH: commandLogPath,
            ENVIRONMENT_LOG_PATH: join(workspaceDirectory, "vitest-env.json"),
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
        ["compose:env", "--write", "--project-suffix", "peerdb-integration"],
        [
          "compose",
          "--",
          "--project-suffix",
          "peerdb-integration",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.peerdb.yml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
        ],
        ["exec", "vitest", "run", "--project", "peerdb-integration"],
        [
          "compose",
          "--",
          "--project-suffix",
          "peerdb-integration",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.peerdb.yml",
          "down",
          "--remove-orphans",
          "--volumes",
        ],
      ]);
      expect(JSON.parse(readFileSync(join(workspaceDirectory, "vitest-env.json"), "utf8"))).toEqual(
        {
          PEERDB_CDC_HOST: "127.0.0.1",
          PEERDB_CDC_PORT: "13000",
          PEERDB_UI_PORT: "13001",
          POSTGRES_PASSWORD: "health",
        },
      );
    } finally {
      rmSync(workspaceDirectory, { force: true, recursive: true });
    }
  });
});
