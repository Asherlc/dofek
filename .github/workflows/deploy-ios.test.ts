import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

describe("iOS deployment detection", () => {
  it.each([
    ["workflow_dispatch", "github-actions[bot]", false],
    ["workflow_dispatch", "Asherlc", true],
    ["workflow_run", "Asherlc", false],
  ])("uses the native-change check for %s by %s (force=%s)", (event, actor, force) => {
    const workflow = z
      .object({
        jobs: z.object({
          check: z.object({
            steps: z.array(
              z.object({
                name: z.string().optional(),
                run: z.string().optional(),
              }),
            ),
          }),
        }),
      })
      .parse(parse(readFileSync(".github/workflows/deploy-ios.yml", "utf8")));
    const script = workflow.jobs.check.steps.find(
      (step) => step.name === "Detect iOS native changes",
    )?.run;
    expect(script).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "deploy-ios-detect-"));
    const argsPath = join(directory, "args.json");
    const outputPath = join(directory, "output");
    try {
      writeFileSync(
        join(directory, "pnpm"),
        `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.TEST_ARGS, JSON.stringify(process.argv.slice(2)));
console.log("false");
`,
      );
      chmodSync(join(directory, "pnpm"), 0o755);
      writeFileSync(outputPath, "");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script ?? ""], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          GITHUB_EVENT_NAME: event,
          GITHUB_ACTOR: actor,
          GITHUB_REPOSITORY: "owner/dofek",
          GITHUB_OUTPUT: outputPath,
          SHA: "a".repeat(40),
          TEST_ARGS: argsPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
        "tsx",
        "scripts/testflight-deployment-cli.ts",
        "detect",
        "owner/dofek",
        "a".repeat(40),
        ...(force ? ["--force"] : []),
      ]);
      expect(readFileSync(outputPath, "utf8")).toBe("should_deploy=false\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
