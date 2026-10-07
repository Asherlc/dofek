import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { beforeEach, expect, it, vi } from "vitest";
import { runWithTokenUser } from "../db/token-user-context.ts";
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

beforeEach(() => vi.clearAllMocks());

it.each([undefined, "context-user"])(
  "attributes explicit-user HTTP failures when the active context is %s",
  async (contextUser) => {
    const fetchFn = createProviderRateLimitFetch(
      "peloton",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      { userId: "explicit-user" },
    );
    const request = () => fetchFn("https://api.onepeloton.com/api/me");
    await (contextUser ? runWithTokenUser(contextUser, request) : request());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"userId":"explicit-user"'));
  },
);

it.each([undefined, null])(
  "uses the active user context when the HTTP user is %s",
  async (userId) => {
    const fetchFn = createProviderRateLimitFetch(
      "peloton",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      { userId },
    );
    await runWithTokenUser("context-user", () => fetchFn("https://api.onepeloton.com/api/me"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"userId":"context-user"'));
  },
);

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
