import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { ProviderAuthError } from "../auth-errors.ts";
import { CrimpdClient } from "./client.ts";

const reply = {
  success: true,
  user: { _id: "owner-1", username: "climber", email: "climber@example.com" },
  token: "access-1",
  refreshToken: "refresh-1",
  expiresIn: 3600,
  refreshExpiresIn: 7200,
};
const tokens: TokenSet = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: new Date("2026-11-01T00:00:00Z"),
  providerAccountId: "owner-1",
  scopes: null,
};

afterEach(() => vi.useRealTimers());

describe("Crimpd account API", () => {
  it("exchanges credentials for expiring tokens tied to the native account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const client = new CrimpdClient(async (input, init) => {
      expect(String(input)).toBe("https://api.crimpd.com/auth/jwt");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        username: "climber@example.com",
        password: "example-password",
      });
      return Response.json(reply);
    });
    expect(await client.login("climber@example.com", "example-password")).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date("2026-11-01T01:00:00Z"),
      providerAccountId: "owner-1",
      scopes: null,
    });
  });

  it.each([400, 401, 403])("makes rejected login actionable for HTTP %s", async (status) => {
    const client = new CrimpdClient(async () => Response.json({ success: false }, { status }));
    await expect(client.login("climber", "wrong-password")).rejects.toThrow(ProviderAuthError);
    await expect(client.login("climber", "wrong-password")).rejects.toThrow(
      /Crimpd.*email.*password/,
    );
  });

  it.each([
    { ...reply, success: false },
    { ...reply, token: "" },
    { ...reply, refreshToken: "" },
    { ...reply, expiresIn: 0 },
    { ...reply, expiresIn: -1 },
    { ...reply, user: {} },
  ])(
    "rejects malformed successful token responses before accepting a connection: %j",
    async (body) => {
      const client = new CrimpdClient(async () => Response.json(body));
      await expect(client.login("climber", "password")).rejects.toThrow(/Crimpd.*response/);
    },
  );

  it("renews using the refresh token and returns the replacement credential", async () => {
    const client = new CrimpdClient(async (input, init) => {
      expect(String(input)).toBe("https://api.crimpd.com/auth/refresh");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
      return Response.json({ ...reply, token: "new-access", refreshToken: "new-refresh" });
    });
    expect(await client.refresh(tokens)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      providerAccountId: "owner-1",
    });
  });

  it("requires reconnect when refresh credentials are absent", async () => {
    const client = new CrimpdClient(async () => {
      throw new Error("Missing credentials must fail before a request");
    });
    await expect(client.refresh({ ...tokens, refreshToken: null })).rejects.toThrow(/Reconnect/);
  });

  it("refuses a refreshed identity belonging to a different account", async () => {
    const client = new CrimpdClient(async () =>
      Response.json({ ...reply, user: { _id: "different-owner" } }),
    );
    await expect(client.refresh(tokens)).rejects.toThrow(/different account/);
  });

  it("makes a revoked refresh authorization actionable", async () => {
    const client = new CrimpdClient(async () => Response.json({ success: false }, { status: 401 }));
    await expect(client.refresh(tokens)).rejects.toThrow(/Reconnect.*Data Sources/);
  });

  it("reports server failures without treating them as invalid passwords", async () => {
    const client = new CrimpdClient(async () => new Response("Unavailable", { status: 503 }));
    await expect(client.login("climber", "password")).rejects.toThrow(/HTTP 503/);
  });

  it("downloads ZIP bytes with the account token and cancellation signal", async () => {
    const controller = new AbortController();
    const client = new CrimpdClient(async (input, init) => {
      expect(String(input)).toBe("https://api.crimpd.com/analytics/export?format=zip");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer old-access");
      expect(init?.signal).toBe(controller.signal);
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { "content-type": "application/zip" },
      });
    });
    expect(await client.downloadExport(tokens, controller.signal)).toEqual(
      new Uint8Array([80, 75, 3, 4]),
    );
  });

  it("requires reconnect when the export rejects authentication", async () => {
    const client = new CrimpdClient(async () => Response.json({ success: false }, { status: 401 }));
    await expect(client.downloadExport(tokens)).rejects.toThrow(ProviderAuthError);
  });

  it("rejects a successful non-ZIP response instead of importing it", async () => {
    const client = new CrimpdClient(async () => Response.json({ success: false }));
    await expect(client.downloadExport(tokens)).rejects.toThrow(/Crimpd.*ZIP/);
  });
});
