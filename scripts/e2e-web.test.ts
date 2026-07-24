import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Scenario {
  downStatus?: number;
  runStatus?: number;
  upStatus?: number;
}

function runScenario({ downStatus = 0, runStatus = 0, upStatus = 0 }: Scenario): {
  commands: string[];
  resourcesRemain: boolean;
  status: number | null;
} {
  const testDirectory = mkdtempSync(join(tmpdir(), "e2e-web-test-"));
  const binaryDirectory = join(testDirectory, "bin");
  const commandLogPath = join(testDirectory, "commands.log");
  const resourcePath = join(testDirectory, "e2e-resource");
  mkdirSync(binaryDirectory);

  const fakePnpmPath = join(binaryDirectory, "pnpm");
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
const { appendFileSync, rmSync, writeFileSync } = require("node:fs");
const command = process.argv[2];
appendFileSync(process.env.COMMAND_LOG_PATH, command + "\\n");
if (command === "e2e:web:up") {
  writeFileSync(process.env.RESOURCE_PATH, "running");
  process.exit(Number(process.env.UP_STATUS));
}
if (command === "e2e:web:run") {
  process.exit(Number(process.env.RUN_STATUS));
}
if (command === "e2e:web:down") {
  rmSync(process.env.RESOURCE_PATH, { force: true });
  process.exit(Number(process.env.DOWN_STATUS));
}
process.exit(99);
`,
  );
  chmodSync(fakePnpmPath, 0o755);

  try {
    const result = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/e2e-web.ts")], {
      env: {
        ...process.env,
        COMMAND_LOG_PATH: commandLogPath,
        DOWN_STATUS: String(downStatus),
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        RESOURCE_PATH: resourcePath,
        RUN_STATUS: String(runStatus),
        UP_STATUS: String(upStatus),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      commands: readFileSync(commandLogPath, "utf8").trim().split("\n"),
      resourcesRemain: existsSync(resourcePath),
      status: result.status,
    };
  } finally {
    rmSync(testDirectory, { force: true, recursive: true });
  }
}

describe("e2e-web", () => {
  it("returns the setup failure after teardown and skips Cypress", () => {
    expect(runScenario({ downStatus: 29, upStatus: 17 })).toEqual({
      commands: ["e2e:web:up", "e2e:web:down"],
      resourcesRemain: false,
      status: 17,
    });
  });

  it("returns the Cypress failure after teardown", () => {
    expect(runScenario({ runStatus: 23 })).toEqual({
      commands: ["e2e:web:up", "e2e:web:run", "e2e:web:down"],
      resourcesRemain: false,
      status: 23,
    });
  });

  it("returns zero and removes E2E resources after success", () => {
    expect(runScenario({})).toEqual({
      commands: ["e2e:web:up", "e2e:web:run", "e2e:web:down"],
      resourcesRemain: false,
      status: 0,
    });
  });

  it("returns a teardown failure when setup and Cypress succeed", () => {
    expect(runScenario({ downStatus: 31 })).toEqual({
      commands: ["e2e:web:up", "e2e:web:run", "e2e:web:down"],
      resourcesRemain: false,
      status: 31,
    });
  });
});
