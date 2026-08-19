import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readEntrypoint(): string {
  return readFileSync(new URL("./entrypoint.sh", import.meta.url), "utf8");
}

describe("entrypoint cdc-health mode", () => {
  it("persists each CDC health result while continuing checks at the configured interval", () => {
    const entrypoint = readEntrypoint();
    const cdcHealthBlockMatch = entrypoint.match(/ {2}cdc-health\)\n(?<body>[\s\S]*?)\n {4};;/);
    const cdcHealthBlock = cdcHealthBlockMatch?.groups?.body;

    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts initialize");
    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts success");
    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts failure");
    expect(cdcHealthBlock).toMatch(
      /echo "cdc-health: check failed with exit status \$status; retrying in \$\{interval_seconds\}s"/,
    );
    expect(cdcHealthBlock).toContain('sleep "$interval_seconds"');
  });

  it("records successful CDC health before starting reconciliation and skips reconciliation after a failed check", () => {
    const entrypoint = readEntrypoint();
    const cdcHealthBlockMatch = entrypoint.match(/ {2}cdc-health\)\n(?<body>[\s\S]*?)\n {4};;/);
    const cdcHealthBlock = cdcHealthBlockMatch?.groups?.body;
    const cdcCheckMatch = cdcHealthBlock?.match(
      /if \$NODE scripts\/check-clickhouse-cdc\.ts; then\n(?<successfulCheckBody>[\s\S]*?)\n {6}else\n {8}status="\$\?"\n(?<failedCheckBody>[\s\S]*?)\n {6}fi/,
    );
    const successfulCheckBlock = cdcCheckMatch?.groups?.successfulCheckBody;
    const failedCheckBlock = cdcCheckMatch?.groups?.failedCheckBody;

    expect(successfulCheckBlock).toContain("$NODE scripts/cdc-health-state.ts success");
    expect(successfulCheckBlock).toContain("$NODE scripts/reconcile-pending-processing.ts");
    expect(successfulCheckBlock?.indexOf("$NODE scripts/cdc-health-state.ts success")).toBeLessThan(
      successfulCheckBlock?.indexOf("$NODE scripts/reconcile-pending-processing.ts") ?? 0,
    );
    expect(failedCheckBlock).not.toContain("scripts/reconcile-pending-processing.ts");
    expect(successfulCheckBlock).toContain(
      "cdc-health: processing reconciliation failed with exit status $status",
    );
  });
});

describe("entrypoint provider connection cutover mode", () => {
  it("runs the resumable connection backfill as a one-shot command", () => {
    const entrypoint = readEntrypoint();

    expect(entrypoint).toContain(`provider-connection-cutover)
    exec $NODE scripts/backfill-provider-connections.ts`);
  });
});
