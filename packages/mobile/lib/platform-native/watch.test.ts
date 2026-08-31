import { describe, expect, it, vi } from "vitest";

vi.mock("../../modules/watch-motion", () => ({}));

import { watchGateway } from "./watch.ios";

describe("iOS watch gateway", () => {
  it("identifies the watchOS implementation without exposing a platform check to consumers", () => {
    expect(watchGateway.kind).toBe("watch-os");
  });
});
