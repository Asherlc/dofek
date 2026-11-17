import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const action = z
  .object({
    runs: z.object({ steps: z.array(z.object({ name: z.string(), run: z.string() })) }),
  })
  .parse(parse(readFileSync(".github/actions/load-infisical-secrets/action.yml", "utf8")));
const installScript = action.runs.steps.find((step) => step.name === "Install Infisical CLI")?.run;
if (!installScript) throw new Error("Missing Infisical install script");

function attemptInstall(architecture: string) {
  const directory = mkdtempSync(join(tmpdir(), "infisical-install-"));
  const trace = join(directory, "download");
  try {
    writeFileSync(trace, "");
    symlinkSync("/usr/bin/mktemp", join(directory, "mktemp"));
    writeFileSync(
      join(directory, "curl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$INSTALL_TRACE"\nexit 73\n',
      { mode: 0o755 },
    );
    const result = spawnSync("/bin/bash", ["-c", installScript], {
      encoding: "utf8",
      env: {
        PATH: directory,
        TMPDIR: directory,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: architecture,
        INSTALL_TRACE: trace,
      },
    });
    return { ...result, download: readFileSync(trace, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Infisical CLI installation", () => {
  it.each([
    ["X64", "amd64"],
    ["ARM64", "arm64"],
  ])("selects the Linux binary for %s runners", (runnerArchitecture, artifactArchitecture) => {
    const result = attemptInstall(runnerArchitecture);
    expect(result.status, result.stderr).toBe(73);
    expect(result.download).toContain(`_linux_${artifactArchitecture}.tar.gz`);
  });

  it("rejects unsupported architectures before downloading an executable", () => {
    const result = attemptInstall("ARM");
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("Unsupported runner architecture: ARM");
    expect(result.download).toBe("");
  });
});
