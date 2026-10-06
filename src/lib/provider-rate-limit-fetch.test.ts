import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { expect, it, vi } from "vitest";
import { createProviderRateLimitFetch } from "./provider-rate-limit-fetch.ts";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.ts", () => ({ logger: { warn, debug: vi.fn() } }));
vi.mock("./error-reporting.ts", () => ({ captureException: vi.fn() }));
vi.mock("./provider-adaptive-rate-limit.ts", () => ({
  providerAdaptiveRateLimitStore: {
    awaitAdmission: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

it("instruments provider failures through the canonical HTTP wrapper", async () => {
  const response = new Response("Unauthorized", { status: 401 });
  const fetchFn = createProviderRateLimitFetch("peloton", vi.fn().mockResolvedValue(response));
  expect(await fetchFn("https://api.onepeloton.com/api/me")).toBe(response);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"http_failed"'));
});

it("keeps the canonical wrapper idempotent so diagnostics and admission are not duplicated", () => {
  const fetchFn = createProviderRateLimitFetch("peloton", vi.fn());
  expect(createProviderRateLimitFetch("peloton", fetchFn)).toBe(fetchFn);
});

it("preserves package-level fetch wrapper idempotence", () => {
  const fetchFn = createRateLimitAwareFetch(vi.fn(), { providerId: "peloton" });
  expect(createProviderRateLimitFetch("peloton", fetchFn)).toBe(fetchFn);
});
