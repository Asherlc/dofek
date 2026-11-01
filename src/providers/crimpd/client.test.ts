import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";

let ProviderAuthError: typeof import("../auth-errors.ts").ProviderAuthError;
let CrimpdClient: typeof import("./client.ts").CrimpdClient;
let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "crimpd-client-test-"));
  filePath = join(directory, "export.zip");
  vi.resetModules();
  ({ CrimpdClient } = await import("./client.ts"));
  ({ ProviderAuthError } = await import("../auth-errors.ts"));
});

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

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("Crimpd account API", () => {
  it("accepts an export exactly at the 100 MiB limit", async () => {
    let remaining = 100;
    const chunk = new Uint8Array(1024 * 1024);
    const client = new CrimpdClient(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (remaining-- > 0) controller.enqueue(chunk);
              else controller.close();
            },
          }),
          { headers: { "content-type": "application/zip" } },
        ),
    );
    await client.downloadExport(tokens, filePath);
    expect((await stat(filePath)).size).toBe(100 * 1024 * 1024);
  });
  it("rejects a ZIP response without a body", async () => {
    const client = new CrimpdClient(
      async () => new Response(null, { headers: { "content-type": "application/zip" } }),
    );
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(/empty ZIP response/);
  });
  it("cancels a download while streaming bytes", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let reads = 0;
    const client = new CrimpdClient(
      async () =>
        new Response(
          new ReadableStream({
            pull(source) {
              source.enqueue(new Uint8Array([80, 75]));
              if (++reads === 3) controller.abort();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/zip" } },
        ),
    );
    await expect(client.downloadExport(tokens, filePath, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancelled).toBe(true);
  });
  it("rejects exports above 100 MiB without buffering the response", async () => {
    let cancelled = false;
    let reads = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const client = new CrimpdClient(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              reads++;
              if (reads > 103) {
                controller.error(new Error("Test source exceeded expected read bound"));
                return;
              }
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/zip" } },
        ),
    );
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(/100 MiB/);
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(103);
    expect((await stat(filePath)).size).toBeLessThanOrEqual(100 * 1024 * 1024);
  });
  it("accepts a case-insensitive ZIP media type", async () => {
    const client = new CrimpdClient(
      async () =>
        new Response(new Uint8Array([80, 75]), { headers: { "content-type": "Application/Zip" } }),
    );
    await client.downloadExport(tokens, filePath);
    expect(await readFile(filePath)).toEqual(Buffer.from([80, 75]));
  });
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
    { ...reply, token: "   " },
    { ...reply, refreshToken: "   " },
    { ...reply, user: { _id: "   " } },
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
    await expect(client.refresh(tokens)).rejects.toMatchObject({
      authFailureReason: "refresh_token_revoked",
    });
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
    await client.downloadExport(tokens, filePath, controller.signal);
    expect(await readFile(filePath)).toEqual(Buffer.from([80, 75, 3, 4]));
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("requires reconnect when the export rejects authentication", async () => {
    const client = new CrimpdClient(async () => Response.json({ success: false }, { status: 401 }));
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(ProviderAuthError);
  });

  it("rejects a successful non-ZIP response instead of importing it", async () => {
    const client = new CrimpdClient(async () => Response.json({ success: false }));
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(/Crimpd.*ZIP/);
  });
  it("preserves refreshed account ownership when the previous identity is absent", async () => {
    const client = new CrimpdClient(async () =>
      Response.json({
        ...reply,
        token: " new-access ",
        refreshToken: " new-refresh ",
        user: { _id: " owner-1 " },
      }),
    );
    expect(await client.refresh({ ...tokens, providerAccountId: undefined })).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      providerAccountId: "owner-1",
    });
  });
  it("rejects failed exports even when the body resembles a ZIP", async () => {
    const client = new CrimpdClient(
      async () =>
        new Response(new Uint8Array([80, 75]), {
          status: 503,
          headers: { "content-type": "application/zip" },
        }),
    );
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(/HTTP 503/);
  });
  it("accepts ZIP media types with parameters and surrounding whitespace", async () => {
    const client = new CrimpdClient(
      async () =>
        new Response(new Uint8Array([80, 75]), {
          headers: { "content-type": " application/zip ; charset=binary " },
        }),
    );
    await client.downloadExport(tokens, filePath);
    expect(await readFile(filePath)).toEqual(Buffer.from([80, 75]));
  });
  it("rejects an export without a media type", async () => {
    const client = new CrimpdClient(async () => new Response(new Uint8Array([80, 75])));
    await expect(client.downloadExport(tokens, filePath)).rejects.toThrow(/ZIP/);
  });
});
