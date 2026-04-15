import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react-native", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  wrap: vi.fn((component: unknown) => component),
}));

vi.mock("../lib/telemetry", () => ({
  initTelemetry: vi.fn(),
  captureException: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { rootStackScreenOptions } from "./_layout";

describe("rootStackScreenOptions", () => {
  it("uses a minimal back button so route-group names are never shown", () => {
    expect(rootStackScreenOptions.headerBackButtonDisplayMode).toBe("minimal");
  });

  it("uses a generic back title fallback", () => {
    expect(rootStackScreenOptions.headerBackTitle).toBe("Back");
  });
});
