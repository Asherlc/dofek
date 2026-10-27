import { describe, expect, it, vi } from "vitest";
import { createMobileDeveloperClientsApi } from "./developer-clients";

describe("createMobileDeveloperClientsApi", () => {
  it("prefixes the server URL and sends the session as a bearer credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createMobileDeveloperClientsApi({
      serverUrl: "https://dofek.example/",
      sessionToken: "mobile-session-token",
    });

    await api.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dofek.example/api/developer/clients",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(requestHeaders.get("accept")).toBe("application/json");
    expect(requestHeaders.get("authorization")).toBe("Bearer mobile-session-token");
    vi.unstubAllGlobals();
  });

  it("fails before fetch when the session token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = createMobileDeveloperClientsApi({
      serverUrl: "https://dofek.example",
      sessionToken: null,
    });

    await expect(api.list()).rejects.toThrow("Sign in again to manage developer integrations.");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
