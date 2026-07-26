import { describe, expect, it } from "vitest";
import { PelotonAuthenticationError, PelotonResponseError, PelotonServiceError } from "./errors.ts";

describe("Peloton errors", () => {
  it("preserves HTTP diagnostics in service errors", () => {
    const error = new PelotonServiceError(500, "upstream body");

    expect(error.name).toBe("PelotonServiceError");
    expect(error.statusCode).toBe(500);
    expect(error.responseBody).toBe("upstream body");
  });

  it("identifies authentication failures", () => {
    const error = new PelotonAuthenticationError(401, "expired");

    expect(error).toBeInstanceOf(PelotonServiceError);
    expect(error.name).toBe("PelotonAuthenticationError");
  });

  it("records the invalid response source", () => {
    const cause = new Error("invalid");
    const error = new PelotonResponseError("workouts", cause);

    expect(error.source).toBe("workouts");
    expect(error.cause).toBe(cause);
  });
});
