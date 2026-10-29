import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { describe, expect, it, vi } from "vitest";
import { startEarlyMsw } from "./early-msw-lifecycle.ts";

describe("early MSW lifecycle", () => {
  it("intercepts retained fetch, bypasses unmatched requests, and restores fetch on cleanup", async () => {
    const originalFetch = globalThis.fetch;
    const nativeFetch: typeof fetch = async () => new Response("native sentinel", { status: 401 });
    globalThis.fetch = nativeFetch;
    const warnings = vi.spyOn(console, "warn");
    const stop = startEarlyMsw();
    const retainedFetch = globalThis.fetch;
    const server = setupServer(
      http.get("https://fixture.example.test/handled", () => HttpResponse.text("handled")),
    );
    try {
      expect(await (await retainedFetch("https://fixture.example.test/unhandled")).text()).toBe(
        "native sentinel",
      );
      expect(warnings).not.toHaveBeenCalled();
      server.listen({ onUnhandledRequest: "bypass" });
      expect(await (await retainedFetch("https://fixture.example.test/handled")).text()).toBe(
        "handled",
      );
      expect(await (await retainedFetch("https://fixture.example.test/unhandled")).text()).toBe(
        "native sentinel",
      );
    } finally {
      server.close();
      stop();
      const restoredFetch = globalThis.fetch;
      globalThis.fetch = originalFetch;
      warnings.mockRestore();
      expect(restoredFetch).toBe(nativeFetch);
    }
  });
});
