import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";

let EightAClient: typeof import("./client.ts").EightAClient;
beforeEach(async () => {
  vi.resetModules();
  ({ EightAClient } = await import("./client.ts"));
});
afterEach(() => vi.useRealTimers());

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

function loginProtocol(
  override: (
    stage: string,
    state: string,
    init: RequestInit | undefined,
  ) => Response | undefined = () => undefined,
) {
  let state = "";
  const stages: string[] = [];
  const client = new EightAClient(async (input, init) => {
    const url = new URL(String(input));
    const stage = url.pathname.endsWith("/auth")
      ? "auth"
      : url.pathname.endsWith("authenticate")
        ? "form"
        : url.pathname.endsWith("/token")
          ? "token"
          : "userinfo";
    if (stage === "auth") state = url.searchParams.get("state") ?? "";
    stages.push(stage);
    const replaced = override(stage, state, init);
    if (replaced) return replaced;
    if (stage === "auth") {
      expect(init?.redirect).toBe("manual");
      return new Response(
        '<form id="kc-form-login" action="https://vlatka.vertical-life.info/authenticate"></form>',
        { headers: { "set-cookie": "AUTH_SESSION_ID=session; Secure; HttpOnly" } },
      );
    }
    if (stage === "form")
      return new Response(null, {
        status: 302,
        headers: { location: `vl-climbing://oauth2redirect?code=code&state=${state}` },
      });
    if (stage === "token") {
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe("vertical-life-ios");
      return Response.json(tokenReply);
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${tokenReply.access_token}`,
    );
    return Response.json({ scim_id: "owner-uuid" });
  });
  return { client, stages };
}

describe("Vertical-Life direct client", () => {
  it.each([400, 401, 403])(
    "reports an initial exchange HTTP %s as a sign-in failure",
    async (status) => {
      const { client } = loginProtocol((stage) =>
        stage === "token" ? Response.json({ error: "invalid_grant" }, { status }) : undefined,
      );
      await expect(client.login("climber", "password")).rejects.toMatchObject({
        authFailureReason: "authentication_failed",
        message: "Vertical-Life rejected this sign-in. Try signing in again.",
      });
    },
  );
  it("confirms identity through userinfo and preserves scope and expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const { client, stages } = loginProtocol();
    expect(await client.login("climber", "password")).toEqual({
      accessToken: tokenReply.access_token,
      refreshToken: "new-refresh",
      providerAccountId: "owner-uuid",
      expiresAt: new Date("2026-11-01T00:05:00Z"),
      scopes: "openid offline_access",
    });
    expect(stages).toEqual(["auth", "form", "token", "userinfo"]);
  });
  it.each(["auth", "token"])(
    "reports a %s server failure before accepting a successful-looking body",
    async (stage) => {
      const { client } = loginProtocol((current) =>
        current === stage ? Response.json(tokenReply, { status: 503 }) : undefined,
      );
      await expect(client.login("climber", "password")).rejects.toThrow(/HTTP 503/);
    },
  );
  it("rejects userinfo that disagrees with the issuer token", async () => {
    const { client } = loginProtocol((stage) =>
      stage === "userinfo" ? Response.json({ scim_id: "other-owner" }) : undefined,
    );
    await expect(client.login("climber", "password")).rejects.toThrow(
      /inconsistent account identities/,
    );
  });
  it.each([
    [200, undefined, /did not complete.*HTTP 200/],
    [503, "vl-climbing://oauth2redirect", /did not complete.*HTTP 503/],
    [302, undefined, /did not complete/],
    [302, "https://oauth2redirect", /callback state/],
    [302, "vl-climbing://untrusted", /callback state/],
  ] as const)(
    "rejects an incomplete or wrong-destination form result %s %s",
    async (status, destination, error) => {
      const { client } = loginProtocol((stage, state) =>
        stage === "form"
          ? new Response("Verification required", {
              status,
              headers: destination ? { location: `${destination}?code=code&state=${state}` } : {},
            })
          : undefined,
      );
      await expect(client.login("climber", "password")).rejects.toThrow(error);
    },
  );
  it("rejects a callback without an authorization code", async () => {
    const { client } = loginProtocol((stage, state) =>
      stage === "form"
        ? new Response(null, {
            status: 302,
            headers: {
              location: `vl-climbing://oauth2redirect?state=${state}&error=access_denied`,
            },
          })
        : undefined,
    );
    await expect(client.login("climber", "password")).rejects.toThrow(/did not authorize/);
  });
  it.each([401, 403])(
    "renews a rejected HTTP %s data request with persisted authenticated headers",
    async (status) => {
      const saved = vi.fn(async (_tokens: TokenSet) => {});
      const controller = new AbortController();
      const client = new EightAClient(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/token")) {
          expect(new Headers(init?.headers).get("content-type")).toBe(
            "application/x-www-form-urlencoded",
          );
          expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
          expect(init?.signal).toBe(controller.signal);
          return Response.json(tokenReply);
        }
        expect(init?.signal).toBe(controller.signal);
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer access") return new Response(null, { status });
        expect(auth).toBe(`Bearer ${tokenReply.access_token}`);
        expect(saved).toHaveBeenCalledTimes(1);
        if (url.pathname.includes("/profile/"))
          return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
        return Response.json({ ascents: [], pageIndex: 0, totalItems: 0 });
      });
      expect(await client.fetchLogbook(tokens, saved, controller.signal)).toEqual([]);
    },
  );
  it("rejects data-server failures even when their JSON resembles a valid profile", async () => {
    const client = new EightAClient(async () =>
      Response.json({ uuid: "owner-uuid", userSlug: "climber" }, { status: 503 }),
    );
    await expect(client.fetchLogbook(tokens, async () => {})).rejects.toThrow(/HTTP 503/);
  });
  it("rejects a profile belonging to another account", async () => {
    const client = new EightAClient(async () =>
      Response.json({ uuid: "another-owner", userSlug: "climber" }),
    );
    await expect(client.fetchLogbook(tokens, async () => {})).rejects.toThrow(
      /different logbook owner/,
    );
  });
  it("requires stored account identity and renewable authorization", async () => {
    const client = new EightAClient(async () => {
      throw new Error("Must fail before requesting data");
    });
    await expect(
      client.fetchLogbook({ ...tokens, providerAccountId: undefined }, async () => {}),
    ).rejects.toThrow(/Reconnect/);
    await expect(
      client.fetchLogbook(
        { ...tokens, refreshToken: null, expiresAt: new Date(0) },
        async () => {},
      ),
    ).rejects.toThrow(/Reconnect/);
  });
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
    const requested: string[] = [];
    const unsafe = new EightAClient(async (input) => {
      requested.push(String(input));
      return new Response(
        '<form id="kc-form-login" action="https://untrusted.example/authenticate"></form>',
      );
    });
    await expect(unsafe.login("climber", "password")).rejects.toThrow(/login form/i);
    expect(requested).toHaveLength(1);
    expect(requested.map((url) => new URL(url).hostname)).not.toContain("untrusted.example");
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
    await expect(
      revoked.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, async () => {}),
    ).rejects.toMatchObject({ authFailureReason: "refresh_token_revoked" });
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
    const rejected = client.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, async () => {});
    await expect(rejected).rejects.toMatchObject({
      message: "Vertical-Life returned an invalid credential response. Try reconnecting.",
    });
    await expect(rejected).rejects.toMatchObject({ message: expect.not.stringContaining(payload) });
    await expect(rejected).rejects.toMatchObject({
      message: expect.not.stringContaining(Buffer.from(payload).toString("base64url")),
    });
  });
  it("renews and persists each replacement during a logbook spanning multiple token lifetimes", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-01T00:00:00Z");
    vi.setSystemTime(start);
    let renewals = 0;
    const persist = vi.fn(async (_tokens: TokenSet) => {});
    const client = new EightAClient(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        renewals++;
        return Response.json({ ...tokenReply, refresh_token: `refresh-${renewals}` });
      }
      if (url.pathname.includes("/profile/"))
        return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
      const pageIndex = Number(url.searchParams.get("pageIndex"));
      if (url.searchParams.get("category") === "bouldering" && pageIndex === 0) {
        vi.setSystemTime(new Date(start.getTime() + 301_000));
        return Response.json({ ascents: [row], pageIndex, totalItems: 1 });
      }
      expect(persist).toHaveBeenCalledTimes(2);
      return Response.json({ ascents: [], pageIndex, totalItems: 0 });
    });
    try {
      expect(
        await client.fetchLogbook({ ...tokens, expiresAt: new Date(0) }, persist),
      ).toHaveLength(1);
      expect(renewals).toBe(2);
      expect(persist.mock.calls.map((call) => call[0]?.refreshToken)).toEqual([
        "refresh-1",
        "refresh-2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a rejected replacement token to one retry per read", async () => {
    let renewals = 0;
    const client = new EightAClient(async (input) => {
      if (String(input).endsWith("/token")) {
        renewals++;
        return Response.json(tokenReply);
      }
      return new Response(null, { status: 401 });
    });
    await expect(client.fetchLogbook(tokens, async () => {})).rejects.toThrow(/Reconnect/);
    expect(renewals).toBe(1);
  });
  it("rejects an endless stream of unique pages without returning partial history", async () => {
    let pages = 0;
    const client = new EightAClient(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/profile/"))
        return Response.json({ uuid: "owner-uuid", userSlug: "climber" });
      const pageIndex = Number(url.searchParams.get("pageIndex"));
      if (++pages > 10_000) throw new Error("Test stopped an unbounded pagination stream");
      return Response.json({
        ascents: [{ ...row, ascentId: pageIndex }],
        pageIndex,
        totalItems: 1,
      });
    });
    await expect(client.fetchLogbook(tokens, async () => {})).rejects.toThrow(
      /pagination limit.*no data/i,
    );
    expect(pages).toBe(10_000);
  });
});
