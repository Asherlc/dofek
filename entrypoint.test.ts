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
});

describe("entrypoint provider connection cutover mode", () => {
  it("runs the resumable connection backfill as a one-shot command", () => {
    const entrypoint = readEntrypoint();

    expect(entrypoint).toContain(`provider-connection-cutover)
    exec $NODE scripts/backfill-provider-connections.ts`);
  });
});
