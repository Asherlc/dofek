import { OAuth2Tokens } from "arctic";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { revokeIdentityCredentials } from "./identity-credential-revocation.ts";

const server = setupServer();

describe("identity credential revocation", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("revokes the Google refresh token issued by a failed callback", async () => {
    server.use(
      http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("token")).toBe("google-refresh");
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const tokens = new OAuth2Tokens({
      access_token: "google-access",
      refresh_token: "google-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });

    await expect(revokeIdentityCredentials("google", tokens)).resolves.toBeUndefined();
  });

  it("treats an already-invalid Google token as revoked", async () => {
    server.use(
      http.post("https://oauth2.googleapis.com/revoke", () =>
        HttpResponse.json({ error: "invalid_token" }, { status: 400 }),
      ),
    );
    const tokens = new OAuth2Tokens({
      access_token: "google-access",
      token_type: "Bearer",
      expires_in: 3600,
    });

    await expect(revokeIdentityCredentials("google", tokens)).resolves.toBeUndefined();
  });

  it("surfaces other Google revocation failures with the provider error", async () => {
    server.use(
      http.post("https://oauth2.googleapis.com/revoke", () =>
        HttpResponse.json({ error: "invalid_request" }, { status: 400 }),
      ),
    );
    const tokens = new OAuth2Tokens({
      access_token: "google-access",
      token_type: "Bearer",
      expires_in: 3600,
    });

    await expect(revokeIdentityCredentials("google", tokens)).rejects.toThrow(
      "Google credential revocation failed (400): invalid_request",
    );
  });

  it("surfaces a malformed Google revocation response", async () => {
    server.use(
      http.post(
        "https://oauth2.googleapis.com/revoke",
        () =>
          new HttpResponse("not-json", {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const tokens = new OAuth2Tokens({
      access_token: "google-access",
      token_type: "Bearer",
      expires_in: 3600,
    });

    await expect(revokeIdentityCredentials("google", tokens)).rejects.toThrow(SyntaxError);
  });
});
