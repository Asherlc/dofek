import { DeveloperClientsApiError } from "@dofek/auth/developer-clients";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerClientsApi } from "./developer-clients.ts";

describe("web developer-clients transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses same-origin cookie authentication and preserves JSON request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          client: {
            clientId: "ext_web",
            name: "Web client",
            redirectUris: ["https://client.example/callback"],
            scopes: ["nutrition:write"],
            status: "active",
            createdAt: "2026-08-24T20:00:00.000Z",
            lastRotatedAt: "2026-08-24T20:00:00.000Z",
          },
          clientSecret: "raw-secret",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      developerClientsApi.create({
        name: "Web client",
        redirectUris: ["https://client.example/callback"],
        scopes: ["nutrition:write"],
      }),
    ).resolves.toMatchObject({ client: { clientId: "ext_web" }, clientSecret: "raw-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/developer/clients",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          accept: "application/json",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("surfaces the server problem message without generic wrapping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "https://api.dofek.example/problems/validation-error",
            title: "Validation failed",
            status: 422,
            code: "VALIDATION_ERROR",
            message: "The redirect URI is invalid.",
            requestId: "request-web",
            details: [],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await developerClientsApi.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeveloperClientsApiError);
    expect(error).toMatchObject({ message: "The redirect URI is invalid." });
  });
});
