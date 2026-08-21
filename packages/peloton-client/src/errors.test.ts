import { describe, expect, it } from "vitest";
import {
  PelotonAuthenticationError,
  PelotonAuthFlowError,
  PelotonResponseError,
  PelotonServiceError,
} from "./errors.ts";

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

  it("preserves authorization-flow diagnostics", () => {
    const cause = new Error("upstream");
    const error = new PelotonAuthFlowError("token", "exchange failed", {
      cause,
      statusCode: 400,
      responseBody: "invalid grant",
    });

    expect(error.name).toBe("PelotonAuthFlowError");
    expect(error.message).toBe("exchange failed");
    expect(error.stage).toBe("token");
    expect(error.statusCode).toBe(400);
    expect(error.responseBody).toBe("invalid grant");
    expect(error.cause).toBe(cause);
  });

  it("allows authorization-flow diagnostics to be omitted", () => {
    const error = new PelotonAuthFlowError("callback", "missing code");

    expect(error.stage).toBe("callback");
    expect(error.statusCode).toBeUndefined();
    expect(error.responseBody).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("records the invalid response source", () => {
    const cause = new Error("invalid");
    const error = new PelotonResponseError("workouts", cause);

    expect(error.source).toBe("workouts");
    expect(error.cause).toBe(cause);
  });
});
