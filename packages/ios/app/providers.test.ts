import { describe, expect, it } from "vitest";
import { providerActionLabel } from "./providers";

describe("providerActionLabel", () => {
  it("returns Sync for connected providers", () => {
    expect(providerActionLabel("connected")).toBe("Sync");
  });

  it("returns Connect for disconnected providers", () => {
    expect(providerActionLabel("not_connected")).toBe("Connect");
  });

  it("returns Connect for expired providers", () => {
    expect(providerActionLabel("expired")).toBe("Connect");
  });
});
