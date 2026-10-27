import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("createFakeZivaMcpHarness", () => {
  it("retains pending request cancellation through garbage collection", () => {
    const helperUrl = new URL("./test-helpers.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
          import { setImmediate } from "node:timers/promises";
          import { createFakeZivaMcpHarness } from ${JSON.stringify(helperUrl)};

          const harness = createFakeZivaMcpHarness({
            delayedMethods: { "notifications/initialized": Infinity },
          });
          const controller = new AbortController();
          let outcome = "pending";
          void harness.fetch("https://connect.ziva.fit/mcp", {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            signal: AbortSignal.any([controller.signal]),
          }).then(() => { outcome = "resolved"; }, () => { outcome = "aborted"; });

          const initializationDeadline = Date.now() + 1_000;
          while (!harness.jsonRpcMethods.includes("notifications/initialized")) {
            if (Date.now() >= initializationDeadline) {
              throw new Error("Initialization notification did not reach the fake transport");
            }
            await setImmediate();
          }
          for (let turn = 0; turn < 5; turn += 1) {
            globalThis.gc();
            await setImmediate();
          }
          controller.abort();
          await setImmediate();
          process.stdout.write(JSON.stringify({ outcome, closed: harness.transportClosed }));
        `,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ outcome: "aborted", closed: true });
  });
});
