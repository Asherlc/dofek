import { describe, expect, it } from "vitest";
import { climbingSessionDetail, climbingSessionResult } from "./test-helpers.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";

describe("climbing session output", () => {
  it("retains selected source context and unverified angle units", () => {
    const result = climbingSessionsOutputSchema.parse({ result: climbingSessionResult() });
    expect(result.result.sessions[0]?.climbing_log_entries[0]).toEqual(climbingSessionDetail());
    expect(result.result.sessions[0]?.climbing_log_entries[0]?.attempts[0]).toMatchObject({
      scope: "climb",
      outcome: null,
      ropeMethod: "top_rope",
      fellOrHung: true,
    });
  });
});
