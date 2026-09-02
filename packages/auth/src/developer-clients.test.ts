import { describe, expect, it, vi } from "vitest";
import type { DeveloperClientsRequest } from "./developer-clients";
import {
  canonicalizeDeveloperRedirectUri,
  createDeveloperClientsApi,
  DeveloperClientDetailSchema,
  DeveloperClientInputSchema,
  DeveloperClientSecretSchema,
  DeveloperClientSummarySchema,
  DeveloperClientsApiError,
  DeveloperClientUpdateSchema,
} from "./developer-clients";

const summary = {
  clientId: "ext_client",
  name: "Meal importer",
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-24T20:00:00.000Z",
  lastRotatedAt: "2026-08-24T20:00:00.000Z",
} as const;

const detail = {
  ...summary,
  redirectUris: ["https://client.example/callback"],
} as const;

describe("developer client schemas", () => {
  it.each([
    "http://client.example/callback",
    "https://user@client.example/callback",
    "https://:password@client.example/callback",
    "https://client.example/callback#fragment",
    "https://client.example/callback#",
    "not a uri",
  ])("rejects an unsafe redirect URI: %s", (redirectUri) => {
    expect(() => canonicalizeDeveloperRedirectUri(redirectUri)).toThrow();
  });

  it("canonicalizes registration values and rejects canonical duplicates", () => {
    expect(canonicalizeDeveloperRedirectUri("https://client.example")).toBe(
      "https://client.example/",
    );
    const result = DeveloperClientInputSchema.safeParse({
      name: "Meal importer",
      redirectUris: ["https://client.example", "https://client.example/"],
      scopes: ["nutrition:write"],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected duplicate redirect URIs to be rejected");
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: "Redirect URIs must be unique.",
        path: ["redirectUris", 1],
      }),
    );
  });

  it("reports redirect URI validation errors through the input schema", () => {
    const result = DeveloperClientInputSchema.safeParse({
      name: "Meal importer",
      redirectUris: ["http://client.example/callback"],
      scopes: ["nutrition:write"],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected an insecure redirect URI to be rejected");
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message: "Redirect URIs must use HTTPS.",
        path: ["redirectUris", 0],
      }),
    );
  });

  it("trims names and canonicalizes a non-empty redirect set", () => {
    expect(
      DeveloperClientInputSchema.parse({
        name: "  Meal importer  ",
        redirectUris: ["https://client.example"],
        scopes: ["nutrition:write"],
      }),
    ).toEqual({
      name: "Meal importer",
      redirectUris: ["https://client.example/"],
      scopes: ["nutrition:write"],
    });
    expect(
      DeveloperClientInputSchema.safeParse({
        name: "   ",
        redirectUris: ["https://client.example/callback"],
        scopes: ["nutrition:write"],
      }).success,
    ).toBe(false);
    expect(
      DeveloperClientUpdateSchema.safeParse({ name: "Meal importer", redirectUris: [] }).success,
    ).toBe(false);
  });

  it.each([
    { scopes: [] },
    { scopes: ["nutrition:write", "nutrition:write"] },
    { scopes: ["profile:read"] },
    { scopes: ["nutrition:write", "profile:read"] },
  ])("rejects a scope set other than nutrition:write: $scopes", ({ scopes }) => {
    expect(
      DeveloperClientInputSchema.safeParse({
        name: "Meal importer",
        redirectUris: ["https://client.example/callback"],
        scopes,
      }).success,
    ).toBe(false);
  });

  it("keeps raw secrets out of list and detail responses", () => {
    expect(
      DeveloperClientSummarySchema.safeParse({ ...summary, clientSecret: "secret" }).success,
    ).toBe(false);
    expect(
      DeveloperClientDetailSchema.safeParse({ ...detail, clientSecret: "secret" }).success,
    ).toBe(false);
  });

  it("requires a raw secret in create and rotation responses", () => {
    expect(DeveloperClientSecretSchema.safeParse({ client: detail }).success).toBe(false);
    expect(
      DeveloperClientSecretSchema.parse({ client: detail, clientSecret: "one-time-secret" }),
    ).toEqual({ client: detail, clientSecret: "one-time-secret" });
  });
});

describe("developer clients API", () => {
  it("preserves explicit and default problem metadata", () => {
    expect(
      new DeveloperClientsApiError({
        code: "INVALID_CLIENT",
        details: [{ field: "client_id" }],
        message: "The client is invalid.",
        requestId: "request-1",
        status: 401,
      }),
    ).toMatchObject({
      code: "INVALID_CLIENT",
      details: [{ field: "client_id" }],
      message: "The client is invalid.",
      name: "DeveloperClientsApiError",
      requestId: "request-1",
      status: 401,
    });
    expect(
      new DeveloperClientsApiError({
        code: "INVALID_RESPONSE",
        message: "The server returned an invalid response.",
        status: 502,
      }),
    ).toMatchObject({ details: [], requestId: null });
  });

  it("parses a safe problem and surfaces its server message", async () => {
    const api = createDeveloperClientsApi(
      async () =>
        new Response(
          JSON.stringify({
            type: "https://api.dofek.example/problems/not-found",
            title: "Not found",
            status: 404,
            code: "NOT_FOUND",
            message: "The requested integration was not found.",
            requestId: "request-1",
            details: [],
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(api.get("ext_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The requested integration was not found.",
      status: 404,
    });
  });

  it("uses the six management paths and parses their response contracts", async () => {
    const responses = [
      new Response(JSON.stringify([summary])),
      new Response(JSON.stringify({ client: detail, clientSecret: "created-secret" }), {
        status: 201,
      }),
      new Response(JSON.stringify(detail)),
      new Response(JSON.stringify({ ...detail, name: "Updated importer" })),
      new Response(JSON.stringify({ client: detail, clientSecret: "rotated-secret" })),
      new Response(JSON.stringify({ revoked: true })),
    ];
    const request = vi.fn<DeveloperClientsRequest>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    });
    const api = createDeveloperClientsApi(request);

    await expect(api.list()).resolves.toEqual([summary]);
    await expect(
      api.create({
        name: "Meal importer",
        redirectUris: ["https://client.example/callback"],
        scopes: ["nutrition:write"],
      }),
    ).resolves.toMatchObject({ clientSecret: "created-secret" });
    await expect(api.get("ext_client")).resolves.toEqual(detail);
    await expect(
      api.update("ext_client", {
        name: "Updated importer",
        redirectUris: ["https://client.example/callback"],
      }),
    ).resolves.toMatchObject({ name: "Updated importer" });
    await expect(api.rotate("ext_client")).resolves.toMatchObject({
      clientSecret: "rotated-secret",
    });
    await expect(api.revoke("ext_client")).resolves.toEqual({ revoked: true });

    expect(request.mock.calls).toStrictEqual([
      ["/api/developer/clients", { headers: { accept: "application/json" }, method: "GET" }],
      [
        "/api/developer/clients",
        {
          body: JSON.stringify({
            name: "Meal importer",
            redirectUris: ["https://client.example/callback"],
            scopes: ["nutrition:write"],
          }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        },
      ],
      [
        "/api/developer/clients/ext_client",
        { headers: { accept: "application/json" }, method: "GET" },
      ],
      [
        "/api/developer/clients/ext_client",
        {
          body: JSON.stringify({
            name: "Updated importer",
            redirectUris: ["https://client.example/callback"],
          }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "PATCH",
        },
      ],
      [
        "/api/developer/clients/ext_client/rotate",
        { headers: { accept: "application/json" }, method: "POST" },
      ],
      [
        "/api/developer/clients/ext_client/revoke",
        { headers: { accept: "application/json" }, method: "POST" },
      ],
    ]);
  });

  it("encodes path segments and JSON request bodies", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(detail)));
    const api = createDeveloperClientsApi(request);

    await api.update("client id with spaces", {
      name: "Meal importer",
      redirectUris: ["https://client.example/callback"],
    });

    expect(request).toHaveBeenCalledWith(
      "/api/developer/clients/client%20id%20with%20spaces",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Meal importer",
          redirectUris: ["https://client.example/callback"],
        }),
        headers: expect.objectContaining({ "content-type": "application/json" }),
        method: "PATCH",
      }),
    );
  });

  it("fails safely when an error response is not a valid problem", async () => {
    const api = createDeveloperClientsApi(
      async () => new Response("database host leaked", { status: 503 }),
    );

    await expect(api.list()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid response.",
      status: 503,
    });
  });

  it("fails safely when an error response has JSON that is not a problem", async () => {
    const api = createDeveloperClientsApi(
      async () =>
        new Response(JSON.stringify({ message: "database host leaked" }), { status: 503 }),
    );

    await expect(api.list()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid response.",
      status: 503,
    });
  });

  it("fails safely when a successful response violates its contract", async () => {
    const api = createDeveloperClientsApi(
      async () => new Response(JSON.stringify({ unexpected: true })),
    );

    await expect(api.list()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid response.",
      status: 200,
    });
  });
});
