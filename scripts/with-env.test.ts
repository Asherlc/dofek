import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
  const fixtureRoot = mkdtempSync(join(tmpdir(), "with-env-test-"));
  const scriptsDirectory = join(fixtureRoot, "scripts");
  const binDirectory = join(fixtureRoot, "bin");
  mkdirSync(scriptsDirectory);
  mkdirSync(binDirectory);
  fixtureRoots.push(fixtureRoot);

  const scriptPath = join(scriptsDirectory, "with-env.sh");
  copyFileSync(resolve("scripts/with-env.sh"), scriptPath);
  chmodSync(scriptPath, 0o755);
  writeExecutable(join(binDirectory, "infisical"), infisicalScript);

  return { fixtureRoot, scriptPath };
}

function runWithEnv(scriptPath: string, fixtureRoot: string, command: string[] = []) {
  return spawnSync("bash", [scriptPath, ...command], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixtureRoot, "bin")}:${process.env.PATH ?? ""}`,
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
    expect(result.stderr).toContain("Usage: with-env.sh <command>");
  });

  it("exports shell-quoted Infisical values before running the command", () => {
    const injectionMarker = join(tmpdir(), `with-env-injection-${process.pid}`);
    rmSync(injectionMarker, { force: true });
    const secretValue = `value with spaces;$(touch "${injectionMarker}")'quoted`;
    const shellQuotedSecret = `'${secretValue.replaceAll("'", `'"'"'`)}'`;
    const { fixtureRoot, scriptPath } = createFixture(`#!/bin/sh
cat <<'EXPORT_OUTPUT'
export WITH_ENV_TEST_SECRET=${shellQuotedSecret}
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
});
