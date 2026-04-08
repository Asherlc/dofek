import { describe, expect, it, vi } from "vitest";
import { failOnUnhandledExternalRequest } from "./msw.ts";

describe("failOnUnhandledExternalRequest", () => {
  it("bypasses localhost requests", () => {
    const print = {
      error: vi.fn(),
      warning: vi.fn(),
    };

    failOnUnhandledExternalRequest(new Request("http://localhost/containers/create"), print);

    expect(print.error).not.toHaveBeenCalled();
  });

  it("bypasses 127.0.0.1 requests", () => {
    const print = {
      error: vi.fn(),
      warning: vi.fn(),
    };

    failOnUnhandledExternalRequest(new Request("http://127.0.0.1:3000/healthz"), print);

    expect(print.error).not.toHaveBeenCalled();
  });

  it("fails unexpected external requests", () => {
    const print = {
      error: vi.fn(),
      warning: vi.fn(),
    };

    failOnUnhandledExternalRequest(
      new Request("https://api.fitbit.com/1/user/-/activities/list.json"),
      print,
    );

    expect(print.error).toHaveBeenCalledOnce();
  });
});
