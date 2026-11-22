import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Each test boots a full nested Vitest run (~3-5s alone). CI runs it alongside the entire parallel
// unit suite, where CPU contention exceeded the previous 15s cap (job 137104627159).
const DIAGNOSTIC_RUNNER_TIMEOUT_MS = 60_000;
const CAPTURE_CLEANUP_MARGIN_MS = 3_000;

function captureUntilHardStop(
  config: string,
  signal: AbortSignal,
  reachedCheckpoint: (output: string) => boolean,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config, "--retry=0"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let stderrBytes = 0;
    let stderrTail = "";
    let checkpointObserved = false;
    let stopRequested = false;
    let deadlineExpired = false;
    let spawnError: Error | undefined;
    const stop = () => {
      if (!child.pid || stopRequested) return;
      stopRequested = true;
      try {
        // Descendants can hold the runner's pipes open after it exits.
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error);
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    // Fire before the shared test timeout (minus cleanup margin) so a stalled nested runner reports its output.
    const deadline = setTimeout(() => {
      if (!checkpointObserved) {
        deadlineExpired = true;
        stop();
      }
    }, DIAGNOSTIC_RUNNER_TIMEOUT_MS - CAPTURE_CLEANUP_MARGIN_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (!stopRequested && reachedCheckpoint(output)) {
        checkpointObserved = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.once("error", (error) => {
      spawnError = error;
      stop();
    });
    child.once("exit", stop);
    child.once("close", (code, exitSignal) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", stop);
      if (spawnError) reject(spawnError);
      else if (signal.aborted || deadlineExpired) {
        reject(
          new Error(
            `Runner did not reach the checkpoint before abort. stdout tail: ${output.slice(-2000)} stderr tail: ${stderrTail}`,
            { cause: signal.reason },
          ),
        );
      } else if (!checkpointObserved || exitSignal !== "SIGKILL") {
        reject(
          new Error(
            `Unexpected runner exit (code ${code}, signal ${exitSignal}, checkpoint observed ${checkpointObserved}, stderr bytes ${stderrBytes})`,
          ),
        );
      } else resolve(output);
    });
  });
}

describe("integration diagnostics reporter", () => {
  it(
    "projects failed suite, case and module errors before the runner can summarize",
    async ({ signal }) => {
      const dir = mkdtempSync(path.join(process.cwd(), "src/test/diagnostic-runner-"));
      const testFile = path.join(dir, "failed.integration.test.ts");
      const moduleFile = path.join(dir, "module-failed.integration.test.ts");
      const config = path.join(dir, "vitest.config.ts");
      const marker = path.join(dir, "summarized");
      writeFileSync(
        testFile,
        `import { beforeAll, describe, it } from "vitest";
const failure = () => Object.assign(new Error("password=private-token https://private.invalid SELECT secret"), { code: "EPIPE", syscall: "write", headers: { authorization: "private-token" } });
describe("private-suite-title", () => {
  beforeAll(() => { throw failure(); });
  it("private-skipped-title", () => {});
});
it("private-case-title", () => { throw new AggregateError(Array.from({ length: 10 }, () => Object.assign(failure(), { cause: Object.assign(new TypeError("private-cause"), { code: "ECONNRESET", syscall: "read" }) })), "private-aggregate"); });
`,
      );
      writeFileSync(
        moduleFile,
        `import { beforeAll, it } from "vitest";
beforeAll(() => { throw Object.assign(new Error("private-module-error"), { code: "ECONNREFUSED", syscall: "connect" }); });
it("private-module-case", () => {});`,
      );
      writeFileSync(
        config,
        `import { writeFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import Reporter from ${JSON.stringify(path.join(process.cwd(), "scripts/integration-diagnostics-reporter.ts"))};
class ObservedReporter extends Reporter {
  modules = 0;
  async onTestModuleEnd(entity) { super.onTestModuleEnd(entity); if (++this.modules === 2) await new Promise(() => {}); }
  onTestRunEnd() { writeFileSync(${JSON.stringify(marker)}, "done"); }
}
export default defineConfig({ test: { reporters: [new ObservedReporter()], projects: [{ test: { name: "integration", fileParallelism: false, includeTaskLocation: true, include: [${JSON.stringify(testFile)}, ${JSON.stringify(moduleFile)}] } }] } });`,
      );
      try {
        const output = await captureUntilHardStop(
          config,
          signal,
          (text) => text.split('"event":"module.failed"').length >= 3,
        );
        const events = output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const suite = events.find((event) => event.event === "suite.failed");
        expect(suite).toMatchObject({
          error: {
            errors: [
              expect.objectContaining({
                name: "Error",
                code: "EPIPE",
                syscall: "write",
                locations: expect.arrayContaining([
                  expect.stringContaining("failed.integration.test.ts:2:"),
                ]),
              }),
            ],
            truncated: false,
          },
        });
        const failedCase = events.find(
          (event) => event.event === "case.failed" && event.line === 7,
        );
        expect(failedCase.error).toMatchObject({
          truncated: true,
          errors: Array.from({ length: 4 }, () => [
            expect.objectContaining({ name: "Error", code: "EPIPE", syscall: "write" }),
            expect.objectContaining({ name: "TypeError", code: "ECONNRESET", syscall: "read" }),
          ]).flat(),
        });
        expect(
          events.find(
            (event) =>
              event.event === "module.failed" &&
              event.file.endsWith("/module-failed.integration.test.ts"),
          ),
        ).toMatchObject({
          error: {
            errors: [
              expect.objectContaining({
                name: "Error",
                code: "ECONNREFUSED",
                syscall: "connect",
                locations: expect.arrayContaining([
                  expect.stringContaining("module-failed.integration.test.ts:2:"),
                ]),
              }),
            ],
            truncated: false,
          },
        });
        expect(existsSync(marker)).toBe(false);
        expect(output).not.toMatch(
          /password|private-token|private\.invalid|SELECT|authorization|private-suite|private-case|private-aggregate|private-cause|private-module/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DIAGNOSTIC_RUNNER_TIMEOUT_MS,
  );
  it(
    "flushes a real hook start before a hard stop",
    async ({ signal }) => {
      const dir = mkdtempSync(path.join(process.cwd(), "src/test/diagnostic-runner-"));
      const testFile = path.join(dir, "stalled.integration.test.ts");
      const config = path.join(dir, "vitest.config.ts");
      const unitFile = path.join(dir, "other.integration.test.ts");
      const marker = path.join(dir, "unit-complete");
      writeFileSync(
        unitFile,
        `import { writeFileSync } from "node:fs"; import { it } from "vitest"; it("unit", () => writeFileSync(new URL("./unit-complete", import.meta.url), "done"));`,
      );
      writeFileSync(
        testFile,
        'import { beforeAll, describe, it } from "vitest";\ndescribe("secret nested suite", () => {\n  beforeAll(async () => { await new Promise(() => {}); });\n  it("secret dynamic title", () => {});\n});',
      );
      writeFileSync(
        config,
        `import { spawn } from "node:child_process";
import { defineConfig } from "vitest/config";
import root from ${JSON.stringify(path.join(process.cwd(), "vitest.config.ts"))};
import Reporter from ${JSON.stringify(path.join(process.cwd(), "scripts/integration-diagnostics-reporter.ts"))};
class ObservedReporter extends Reporter {
  onHookStart(hook) {
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
    super.onHookStart(hook);
  }
}
const integration = root.test.projects.find(
  (project) => typeof project !== "string" && project.test?.name === "integration",
);
export default defineConfig({
  test: {
    reporters: [new ObservedReporter()],
    projects: [
      { test: { name: "unit", sequence: { groupOrder: 0 }, include: [${JSON.stringify(unitFile)}] } },
      {
        ...integration,
        test: { ...integration.test, setupFiles: [], include: [${JSON.stringify(testFile)}] },
      },
    ],
  },
});`,
      );
      try {
        const output = await captureUntilHardStop(config, signal, (text) =>
          text.includes('"event":"hook.start"'),
        );
        expect(existsSync(marker)).toBe(true);
        expect(output).not.toContain("other.integration.test.ts");
        expect(output).toContain('"event":"module.start"');
        const hook = output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((event) => event.event === "hook.start");
        expect(hook).toMatchObject({ event: "hook.start", hook: "beforeAll", line: 2, column: 1 });
        expect(output).not.toContain('"event":"hook.end"');
        expect(output).not.toContain("secret dynamic title");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DIAGNOSTIC_RUNNER_TIMEOUT_MS,
  );
});
