import { describe, expect, it, vi } from "vitest";
import { buildProblem, sendApiProblem } from "./api-problem.ts";

describe("API problem responses", () => {
  it("builds mapped and unmapped privacy-safe problems", () => {
    expect(buildProblem("RATE_LIMITED", 429, "request-1")).toEqual({
      type: "https://api.dofek.example/problems/rate-limited",
      title: "Too many requests",
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      requestId: "request-1",
      details: [],
    });
    expect(buildProblem("UNMAPPED_CODE", 500, "request-2")).toMatchObject({
      title: "Request failed",
      code: "UNMAPPED_CODE",
      message: "The request failed.",
    });
  });

  it("sends the shared problem envelope with field details", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    sendApiProblem({ status }, "request-3", 422, "VALIDATION_ERROR", [
      { path: ["name"], message: "Enter an integration name." },
    ]);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
        requestId: "request-3",
        details: [{ path: ["name"], message: "Enter an integration name." }],
      }),
    );
  });
});
