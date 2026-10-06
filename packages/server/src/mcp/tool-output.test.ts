import { describe, expect, it } from "vitest";
import { climbingSessionContext, climbingSessionResult } from "./test-helpers.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";

describe("climbing session output", () => {
  it("retains selected source context and unverified angle units", () => {
    const result = climbingSessionsOutputSchema.parse({ result: climbingSessionResult() });
    expect(result.result.sessions[0]?.climbs[0]).toMatchObject({
      context: climbingSessionContext(),
      sent: false,
      attempt_count: null,
      wall_angle_degrees: null,
    });
  });
});
