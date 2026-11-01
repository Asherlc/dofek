import { describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { EightAClient } from "./client.ts";

const tokens: TokenSet = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: new Date("2099-01-01"),
  providerAccountId: "owner-uuid",
  scopes: null,
};
const accessToken = (owner = "owner-uuid") =>
  `header.${Buffer.from(JSON.stringify({ scim_id: owner })).toString("base64url")}.signature`;
const tokenReply = {
  access_token: accessToken(),
  refresh_token: "new-refresh",
  expires_in: 300,
  scope: "openid offline_access",
};
const row = {
  ascentId: 123,
  platform: "eight_a",
  date: "2026-09-01",
  difficulty: "7A",
  zlaggableName: "A boulder",
  cragName: "Example Forest",
  type: "rp",
  repeat: false,
  project: false,
  duplicate: false,
  tries: 0,
};

describe("Vertical-Life direct client", () => {
  it("uses the observed PKCE form login, validates callback state and exchanges the code", async () => {
    let state = "";
    let challenge = "";
    const client = new EightAClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth")) {
        state = url.searchParams.get("state") ?? "";
        challenge = url.searchParams.get("code_challenge") ?? "";
        expect(url.searchParams.get("client_id")).toBe("vertical-life-ios");
        expect(url.searchParams.get("scope")).toContain("offline_access");
        return new Response(
          '<form id="kc-form-login" action="https://vlatka.vertical-life.info/login-actions/authenticate"><input name="username"><input name="password"></form>',
          { headers: { "set-cookie": "AUTH_SESSION_ID=session; Secure; HttpOnly" } },
        );
      }
      if (url.pathname === "/login-actions/authenticate") {
        expect(new Headers(init?.headers).get("cookie")).toBe("AUTH_SESSION_ID=session");
        expect(new URLSearchParams(String(init?.body)).get("username")).toBe("climber@example.com");
        expect(new URLSearchParams(String(init?.body)).get("password")).toBe("password");
        return new Response(null, {
          status: 302,
          headers: { location: `vl-climbing://oauth2redirect?code=code&state=${state}` },
        });
      }
      if (url.pathname.endsWith("/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("code");
        const { createHash } = await import("node:crypto");
        expect(
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge);
        return Response.json(tokenReply);
      }
      if (url.pathname.endsWith("/userinfo")) return Response.json({ scim_id: "owner-uuid" });
      throw new Error("Unexpected request");
    });
    expect(await client.login("climber@example.com", "password")).toMatchObject({
      accessToken: tokenReply.access_token,
      refreshToken: "new-refresh",
      providerAccountId: "owner-uuid",
    });
  });
  it("rejects invalid credentials and does not follow an untrusted form destination", async () => {
    const invalid = new EightAClient(async (input) =>
      String(input).endsWith("authenticate")
        ? new Response('<form id="kc-form-login"></form>')
        : new Response(
            '<form id="kc-form-login" action="https://vlatka.vertical-life.info/authenticate"></form>',
          ),
    );
    await expect(invalid.login("climber", "wrong")).rejects.toThrow(/invalid email or password/i);
    const unsafe = new EightAClient(
      async () =>
        new Response(
          '<form id="kc-form-login" action="https://untrusted.example/authenticate"></form>',
        ),
    );
    await expect(unsafe.login("climber", "password")).rejects.toThrow(/login form/i);
  });
  it("validates callback state before exchanging a code", async () => {
    const client = new EightAClient(async (input) =>
      String(input).endsWith("authenticate")
        ? new Response(null, {
            status: 302,
            headers: { location: "vl-climbing://oauth2redirect?code=code&state=wrong" },
          })
        : new Response(
            '<form id="kc-form-login" action="https://vlatka.vertical-life.info/authenticate"></form>',
          ),
    );
    await expect(client.login("climber", "password")).rejects.toThrow(/state/i);
  });
  it("persists refreshed credentials before any profile or ascent read", async () => {
    const persist = vi.fn(async () => {});
    const client = new EightAClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh");
        return Response.json(tokenReply);
      }
      if (url.pathname.endsWith("/userinfo")) return Response.json({ scim_id: "owner-uuid" });
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: "new-refresh" }),
      );
      if (url.pathname.includes("/profile/"))
        return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
      return Response.json({ ascents: [], pageIndex: 0, totalItems: 0 });
    });
    expect(await client.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, persist)).toEqual([]);
  });
  it("fetches each category from zero until empty, with completeness filters and cancellation", async () => {
    const controller = new AbortController();
    const categories: string[] = [];
    const client = new EightAClient(async (input, init) => {
      expect(init?.signal).toBe(controller.signal);
      const url = new URL(String(input));
      if (url.pathname.includes("/profile/"))
        return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
      const category = url.searchParams.get("category") ?? "";
      categories.push(category);
      expect(url.searchParams.get("includeProjects")).toBe("true");
      expect(url.searchParams.get("showRepeats")).toBe("true");
      expect(url.searchParams.get("showDuplicates")).toBe("true");
      const pageIndex = Number(url.searchParams.get("pageIndex"));
      return Response.json({
        ascents: pageIndex === 0 ? [{ ...row, ascentId: categories.length }] : [],
        pageIndex,
        totalItems: 1,
      });
    });
    expect(await client.fetchLogbook(tokens, async () => {}, controller.signal)).toHaveLength(4);
    expect(categories).toEqual([
      "bouldering",
      "bouldering",
      "sportclimbing",
      "sportclimbing",
      "gymroute",
      "gymroute",
      "gymboulder",
      "gymboulder",
    ]);
  });
  it.each(["repeated", "failed", "malformed"])(
    "rejects a %s later page without returning a partial logbook",
    async (mode) => {
      const client = new EightAClient(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/profile/"))
          return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
        const pageIndex = Number(url.searchParams.get("pageIndex"));
        if (pageIndex && mode === "failed") return new Response(null, { status: 503 });
        if (pageIndex && mode === "malformed") return Response.json({ error: "unavailable" });
        return Response.json({ ascents: [row], pageIndex, totalItems: 1 });
      });
      await expect(client.fetchLogbook(tokens, async () => {})).rejects.toThrow();
    },
  );
  it("requires reconnect for revoked refresh and rejects a changed refreshed account", async () => {
    const revoked = new EightAClient(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await expect(
      revoked.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, async () => {}),
    ).rejects.toThrow(/Reconnect/);
    const changed = new EightAClient(async () =>
      Response.json({ ...tokenReply, access_token: accessToken("other-owner") }),
    );
    const persist = vi.fn(async () => {});
    await expect(
      changed.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, persist),
    ).rejects.toThrow(/different account/);
    expect(persist).not.toHaveBeenCalled();
  });
  it("does not begin renewal for an already cancelled sync", async () => {
    const fetchFn = vi.fn(async () => Response.json(tokenReply));
    const client = new EightAClient(fetchFn);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, async () => {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("reports malformed issuer credentials without leaking their contents", async () => {
    const payload = "private-credential-payload";
    const client = new EightAClient(async () =>
      Response.json({
        ...tokenReply,
        access_token: `header.${Buffer.from(payload).toString("base64url")}.signature`,
      }),
    );
    await expect(
      client.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, async () => {}),
    ).rejects.toThrow(/invalid credential response/i);
  });
});
