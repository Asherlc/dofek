import { describe, expect, it } from "vitest";

import { SERVER_URL, getTrpcUrl } from "./server";

describe("SERVER_URL", () => {
  it("points to production server", () => {
    expect(SERVER_URL).toBe("https://dofek.asherlc.com");
  });
});

describe("getTrpcUrl", () => {
  it("appends /api/trpc to the server URL", () => {
    expect(getTrpcUrl("https://dofek.example.com")).toBe(
      "https://dofek.example.com/api/trpc",
    );
  });

  it("does not double-slash when server URL has no trailing slash", () => {
    const result = getTrpcUrl("http://localhost:3000");
    expect(result).toBe("http://localhost:3000/api/trpc");
  });
});
