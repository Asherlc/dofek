import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readEntrypoint(): string {
  return readFileSync(new URL("../entrypoint.sh", import.meta.url), "utf8");
}

describe("entrypoint cdc-health mode", () => {
  it("continues checking at the configured interval after a failed CDC health check", () => {
    const entrypoint = readEntrypoint();
    const cdcHealthBlockMatch = entrypoint.match(/ {2}cdc-health\)\n(?<body>[\s\S]*?)\n {4};;/);
    const cdcHealthBlock = cdcHealthBlockMatch?.groups?.body;

    expect(cdcHealthBlock).toMatch(
      /echo "cdc-health: check failed with exit status \$status; retrying in \$\{interval_seconds\}s"/,
    );
    expect(cdcHealthBlock).toContain('sleep "$interval_seconds"');
    expect(cdcHealthBlock).not.toContain('exit "$status"');
  });
});
