import { PROVIDER_HTTP_REQUEST_TIMEOUT_MS } from "@dofek/provider-http/rate-limit";
import { TimeoutError } from "impit";
import { describe, expect, it, vi } from "vitest";
import { createTheCragPublicFetch } from "./public-transport.ts";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), options: vi.fn() }));
vi.mock("impit", () => ({
  TimeoutError: class TimeoutError extends Error {},
  Impit: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    fetch = mocks.fetch;
  },
}));

describe("theCrag public HTTP transport", () => {
  it("exposes native deadline failures to the shared queue retry policy", async () => {
    mocks.fetch.mockRejectedValueOnce(new TimeoutError("native deadline exceeded"));
    await expect(
      createTheCragPublicFetch()("https://www.thecrag.com/ascent/1001"),
    ).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      providerId: "thecrag",
      timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
    });
  });
  it("uses Chrome TLS profile and native deadline and normalizes a streamed response", async () => {
    const response = new Response("public data", { headers: { "Retry-After": "3" } });
    mocks.fetch.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: response.headers,
      body: response.body,
      url: "https://www.thecrag.com/en/ascent/1001",
    });
    const signal = new AbortController().signal;
    const body = await createTheCragPublicFetch()("https://www.thecrag.com/ascent/1001", {
      signal,
      headers: { Accept: "text/html" },
    });
    expect(mocks.options).toHaveBeenCalledWith({
      browser: "chrome",
      timeout: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
      followRedirects: false,
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://www.thecrag.com/ascent/1001",
      expect.objectContaining({
        method: "GET",
        signal,
        timeout: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
        redirect: "manual",
      }),
    );
    expect(body).toBeInstanceOf(Response);
    expect(body.url).toBe("https://www.thecrag.com/en/ascent/1001");
    expect(body.headers.get("Retry-After")).toBe("3");
    expect(await body.clone().text()).toBe("public data");
    expect(await body.text()).toBe("public data");
  });
});
