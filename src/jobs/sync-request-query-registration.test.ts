import { beforeEach, describe, expect, it, vi } from "vitest";

const registerSpy = vi.fn();

vi.mock("../lib/sync-request-query.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sync-request-query.ts")>()),
  registerSyncRequestQueryResolver: registerSpy,
}));

const mockGarminResolver = vi.fn();
const mockWhoopResolver = vi.fn();

vi.mock("../providers/garmin/sync-request-query.ts", () => ({
  resolveGarminSyncRequestQuery: mockGarminResolver,
}));

vi.mock("../providers/whoop/sync-request-query.ts", () => ({
  resolveWhoopSyncRequestQuery: mockWhoopResolver,
}));

describe("registerProviderSyncRequestResolver", () => {
  beforeEach(() => {
    registerSpy.mockClear();
  });

  it("registers the garmin resolver for the garmin provider", async () => {
    const { registerProviderSyncRequestResolver } = await import(
      "./sync-request-query-registration.ts"
    );

    await registerProviderSyncRequestResolver({ id: "garmin" });

    expect(registerSpy).toHaveBeenCalledWith("garmin", mockGarminResolver);
  });

  it("registers the whoop resolver for the whoop provider", async () => {
    const { registerProviderSyncRequestResolver } = await import(
      "./sync-request-query-registration.ts"
    );

    await registerProviderSyncRequestResolver({ id: "whoop" });

    expect(registerSpy).toHaveBeenCalledWith("whoop", mockWhoopResolver);
  });

  it("does nothing for providers without a custom resolver", async () => {
    const { registerProviderSyncRequestResolver } = await import(
      "./sync-request-query-registration.ts"
    );

    await registerProviderSyncRequestResolver({ id: "strava" });

    expect(registerSpy).not.toHaveBeenCalled();
  });
});
