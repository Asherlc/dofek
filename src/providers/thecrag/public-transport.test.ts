import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROVIDER_HTTP_REQUEST_TIMEOUT_MS } from "@dofek/provider-http/rate-limit";
import impit from "impit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTheCragPublicFetch } from "./public-transport.ts";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), options: vi.fn(), captureException: vi.fn() }));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));
vi.mock("impit", () => ({
  default: {
    TimeoutError: class TimeoutError extends Error {},
    Impit: class {
      constructor(options: unknown) {
        mocks.options(options);
      }
      fetch = mocks.fetch;
    },
  },
}));
afterEach(() => vi.clearAllMocks());

describe("theCrag public HTTP transport", () => {
  it("loads and constructs the actual adapter in native Node ESM without bundler interop", async () => {
    const moduleUrl = new URL("./public-transport.ts", import.meta.url).href;
    await expect(
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "--eval",
        `const adapter = await import(${JSON.stringify(moduleUrl)}); console.log(typeof adapter.createTheCragPublicFetch());`,
      ]),
    ).resolves.toMatchObject({ stdout: "function\n" });
  });
  it("exposes native deadline failures to the shared queue retry policy", async () => {
    mocks.fetch.mockRejectedValueOnce(new impit.TimeoutError("native deadline exceeded"));
    await expect(
      createTheCragPublicFetch()("https://www.thecrag.com/ascent/1001"),
    ).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      providerId: "thecrag",
      timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ProviderRequestTimeoutError", providerId: "thecrag" }),
      { tags: { provider: "thecrag", phase: "public_request" } },
    );
  });
  it("preserves other native request failures without classifying them as timeouts", async () => {
    const error = new Error("TLS connection refused");
    mocks.fetch.mockRejectedValueOnce(error);
    await expect(createTheCragPublicFetch()("https://www.thecrag.com/ascent/1001")).rejects.toBe(
      error,
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
  it("keeps URL normalization separate from whether a redirect was followed", async () => {
    const response = new Response("public data");
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: response.headers,
      body: response.body,
      url: "https://www.thecrag.com/ascent/1001",
    });
    const normalized = await createTheCragPublicFetch()("https://www.thecrag.com:443/ascent/1001");
    expect(normalized.url).toBe("https://www.thecrag.com/ascent/1001");
    expect(normalized.redirected).toBe(false);
    expect(await normalized.text()).toBe("public data");
  });
  it("preserves a denied response's status, headers and body for shared HTTP diagnostics", async () => {
    const response = new Response("Public access denied", {
      status: 403,
      statusText: "Forbidden",
      headers: { "Retry-After": "3" },
    });
    mocks.fetch.mockResolvedValueOnce({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      url: "https://www.thecrag.com/ascent/1001",
    });
    const normalized = await createTheCragPublicFetch()("https://www.thecrag.com/ascent/1001");
    expect(normalized.status).toBe(403);
    expect(normalized.statusText).toBe("Forbidden");
    expect(normalized.headers.get("Retry-After")).toBe("3");
    expect(normalized.redirected).toBe(false);
    expect(await normalized.text()).toBe("Public access denied");
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
    expect(mocks.fetch.mock.calls[0]?.[1].headers.get("Accept")).toBe("text/html");
    expect(body).toBeInstanceOf(Response);
    expect(body.url).toBe("https://www.thecrag.com/en/ascent/1001");
    expect(body.headers.get("Retry-After")).toBe("3");
    expect(await body.clone().text()).toBe("public data");
    expect(await body.text()).toBe("public data");
  });
});
