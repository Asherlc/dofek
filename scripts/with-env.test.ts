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
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoots: string[] = [];

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createFixture(infisicalScript: string): {
  fixtureRoot: string;
  scriptPath: string;
} {
  mkdirSync(resolve(".context"), { recursive: true });
  const fixtureRoot = mkdtempSync(resolve(".context", "with-env-test-"));
  const scriptsDirectory = join(fixtureRoot, "scripts");
  const binDirectory = join(fixtureRoot, "bin");
  mkdirSync(scriptsDirectory);
  mkdirSync(binDirectory);
  fixtureRoots.push(fixtureRoot);

  const scriptPath = join(scriptsDirectory, "with-env.ts");
  writeFileSync(scriptPath, readFileSync(resolve("scripts/with-env.ts"), "utf8"));
  writeExecutable(join(binDirectory, "infisical"), infisicalScript);

  return { fixtureRoot, scriptPath };
}

function runWithEnv(
  scriptPath: string,
  fixtureRoot: string,
  command: string[] = [],
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  return spawnSync("pnpm", ["tsx", scriptPath, "--", ...command], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixtureRoot, "bin")}:${process.env.PATH ?? ""}`,
      ...environmentOverrides,
    },
  });
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("with-env", () => {
  it("fails before running the command when Infisical export fails", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
printf '%s\n' 'authentication expired' >&2
exit 42
`);
    const commandMarker = join(fixtureRoot, "command-ran");
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
touch "$1"
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand, commandMarker]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to export secrets from Infisical");
    expect(existsSync(commandMarker)).toBe(false);
  });

  it("fails when no command is provided", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
exit 0
`);

    const result = runWithEnv(scriptPath, fixtureRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: with-env.ts <command>");
  });

  it("exports Infisical values without evaluating their contents", () => {
    const injectionMarker = join(tmpdir(), `with-env-injection-${process.pid}`);
    rmSync(injectionMarker, { force: true });
    const secretValue = `value with spaces;$(touch "${injectionMarker}")'quoted`;
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
cat <<'EXPORT_OUTPUT'
${JSON.stringify([{ key: "WITH_ENV_TEST_SECRET", value: secretValue }])}
EXPORT_OUTPUT
`);
    const capturedValuePath = join(fixtureRoot, "captured-value");
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
printf '%s' "$WITH_ENV_TEST_SECRET" > "$1"
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand, capturedValuePath]);

    expect(result.status).toBe(0);
    expect(readFileSync(capturedValuePath, "utf8")).toBe(secretValue);
    expect(existsSync(injectionMarker)).toBe(false);
  });

  it("applies workspace-local overrides after Infisical secrets", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
cat <<'EXPORT_OUTPUT'
${JSON.stringify([
  { key: "WITH_ENV_TEST_VALUE", value: "infisical" },
  { key: "SENTRY_ENVIRONMENT", value: "production" },
])}
EXPORT_OUTPUT
`);
    writeFileSync(
      join(fixtureRoot, ".env.local"),
      "WITH_ENV_TEST_VALUE=workspace-local\nSENTRY_ENVIRONMENT=development\n",
    );
    const capturedValuePath = join(fixtureRoot, "captured-value");
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
printf '%s\n%s' "$WITH_ENV_TEST_VALUE" "$SENTRY_ENVIRONMENT" > "$1"
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand, capturedValuePath]);

    expect(result.status).toBe(0);
    expect(readFileSync(capturedValuePath, "utf8")).toBe("workspace-local\ndevelopment");
  });

  it("defaults local Sentry events to development instead of the Infisical environment", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
cat <<'EXPORT_OUTPUT'
${JSON.stringify([{ key: "SENTRY_ENVIRONMENT", value: "production" }])}
EXPORT_OUTPUT
`);
    const capturedValuePath = join(fixtureRoot, "captured-value");
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
printf '%s' "$SENTRY_ENVIRONMENT" > "$1"
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand, capturedValuePath], {
      SENTRY_ENVIRONMENT: undefined,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(capturedValuePath, "utf8")).toBe("development");
  });

  it("preserves an explicit caller Sentry environment", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
cat <<'EXPORT_OUTPUT'
${JSON.stringify([{ key: "SENTRY_ENVIRONMENT", value: "production" }])}
EXPORT_OUTPUT
`);
    const capturedValuePath = join(fixtureRoot, "captured-value");
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
printf '%s' "$SENTRY_ENVIRONMENT" > "$1"
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand, capturedValuePath], {
      SENTRY_ENVIRONMENT: "staging",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(capturedValuePath, "utf8")).toBe("staging");
  });

  it("propagates a wrapped command termination as a shell-compatible exit status", () => {
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
printf '[]'
`);
    const wrappedCommand = join(fixtureRoot, "bin", "wrapped-command");
    writeExecutable(
      wrappedCommand,
      `#!/bin/sh
kill -TERM $$
`,
    );

    const result = runWithEnv(scriptPath, fixtureRoot, [wrappedCommand]);

    expect(result.status).toBe(143);
    expect(result.signal).toBeNull();
  });
});
