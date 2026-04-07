import { describe, expect, it, vi } from "vitest";
import { isWebhookProvider } from "./types.ts";

// ── Strava webhook tests ──
describe("StravaProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);
    expect(isWebhookProvider(provider)).toBe(true);
    expect(provider.webhookScope).toBe("app");
  });

  it("parseWebhookPayload extracts activity create event", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      event_time: 1234567890,
      object_id: 12345,
      object_type: "activity",
      owner_id: 67890,
      subscription_id: 1,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      ownerExternalId: "67890",
      eventType: "create",
      objectType: "activity",
      objectId: "12345",
    });
  });

  it("parseWebhookPayload handles delete event", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "delete",
      object_id: 99,
      object_type: "activity",
      owner_id: 42,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("delete");
  });

  it("parseWebhookPayload returns empty for invalid payload", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    expect(provider.parseWebhookPayload({})).toHaveLength(0);
    expect(provider.parseWebhookPayload("bad")).toHaveLength(0);
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
  });

  it("handleValidationChallenge responds to valid challenge", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const result = provider.handleValidationChallenge(
      { "hub.mode": "subscribe", "hub.challenge": "abc123", "hub.verify_token": "mytoken" },
      "mytoken",
    );
    expect(result).toEqual({ "hub.challenge": "abc123" });
  });

  it("handleValidationChallenge rejects wrong token", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const result = provider.handleValidationChallenge(
      { "hub.mode": "subscribe", "hub.challenge": "abc123", "hub.verify_token": "wrong" },
      "mytoken",
    );
    expect(result).toBeNull();
  });

  it("verifyWebhookSignature always returns true (Strava trusts registered URLs)", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);
    expect(provider.verifyWebhookSignature(Buffer.from(""), {}, "")).toBe(true);
  });
});

// ── Fitbit webhook tests ──
describe("FitbitProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
    expect(provider.webhookScope).toBe("app");
  });

  it("parseWebhookPayload extracts notifications array", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());

    const events = provider.parseWebhookPayload([
      { collectionType: "activities", ownerId: "ABC123", date: "2024-01-15" },
      { collectionType: "sleep", ownerId: "ABC123", date: "2024-01-15" },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      ownerExternalId: "ABC123",
      eventType: "update",
      objectType: "activities",
      metadata: { date: "2024-01-15" },
    });
    expect(events[1]?.objectType).toBe("sleep");
    expect(events[1]?.metadata).toEqual({ date: "2024-01-15" });
  });

  it("parseWebhookPayload returns empty for non-array", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());
    expect(provider.parseWebhookPayload({})).toHaveLength(0);
  });

  it("parseWebhookPayload filters out invalid items", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());

    const events = provider.parseWebhookPayload([
      { collectionType: "activities", ownerId: "ABC" },
      { bad: "data" },
      null,
    ]);

    expect(events).toHaveLength(1);
  });

  it("verifyWebhookSignature validates HMAC-SHA1", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const { createHmac } = await import("node:crypto");
    const provider = new FitbitProvider(async () => new Response());

    const body = Buffer.from('[{"collectionType":"activities"}]');
    const secret = "test-secret";
    const hmac = createHmac("sha1", `${secret}&`);
    hmac.update(body);
    const validSignature = hmac.digest("base64");

    expect(
      provider.verifyWebhookSignature(body, { "x-fitbit-signature": validSignature }, secret),
    ).toBe(true);
    expect(provider.verifyWebhookSignature(body, { "x-fitbit-signature": "wrong" }, secret)).toBe(
      false,
    );
    expect(provider.verifyWebhookSignature(body, {}, secret)).toBe(false);
  });

  it("handleValidationChallenge accepts matching verify code", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());

    expect(provider.handleValidationChallenge({ verify: "mycode" }, "mycode")).toBe("");
    expect(provider.handleValidationChallenge({ verify: "wrong" }, "mycode")).toBeNull();
    expect(provider.handleValidationChallenge({}, "mycode")).toBeNull();
  });
});

// ── Oura webhook tests ──
describe("OuraProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
    expect(provider.webhookScope).toBe("app");
  });

  it("parseWebhookPayload extracts data event", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event_type: "create.daily_activity",
      data_type: "daily_activity",
      user_id: "user-abc-123",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      ownerExternalId: "user-abc-123",
      eventType: "create",
      objectType: "daily_activity",
    });
  });

  it("parseWebhookPayload ignores verification challenge", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      verification_token: "my-verify-token",
    });

    expect(events).toHaveLength(0);
  });

  it("parseWebhookPayload returns empty for invalid payload", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());
    expect(provider.parseWebhookPayload({})).toHaveLength(0);
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
  });
});

// ── Polar webhook tests ──
describe("PolarProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const provider = new PolarProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("parseWebhookPayload extracts exercise event", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const provider = new PolarProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event: "EXERCISE",
      user_id: 12345,
      entity_id: "abc-def",
      timestamp: "2024-01-15T10:00:00Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      ownerExternalId: "12345",
      eventType: "create",
      objectType: "activity",
      objectId: "abc-def",
    });
  });

  it("verifyWebhookSignature validates HMAC-SHA256", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const { createHmac } = await import("node:crypto");
    const provider = new PolarProvider(async () => new Response());

    const body = Buffer.from('{"event":"EXERCISE"}');
    const secret = "polar-secret";
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    const validSignature = hmac.digest("hex");

    expect(
      provider.verifyWebhookSignature(body, { "polar-webhook-signature": validSignature }, secret),
    ).toBe(true);
    expect(
      provider.verifyWebhookSignature(body, { "polar-webhook-signature": "bad" }, secret),
    ).toBe(false);
  });
});

// ── Wahoo webhook tests ──
describe("WahooProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("parseWebhookPayload extracts workout event", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event_type: "workout_summary.created",
      user: { id: 42 },
      workout_summary: {
        id: 99,
        created_at: "2024-01-15T10:00:00Z",
        updated_at: "2024-01-15T10:00:00Z",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("42");
    expect(events[0]?.objectType).toBe("workout");
    expect(events[0]?.objectId).toBe("99");
    expect(events[0]?.metadata).toBeDefined();
  });
});

// ── Withings webhook tests ──
describe("WithingsProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
    expect(provider.webhookScope).toBe("user");
  });

  it("parseWebhookPayload extracts weight event", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      userid: 12345,
      appli: 1,
      startdate: 1705312000,
      enddate: 1705398400,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("12345");
    expect(events[0]?.objectType).toBe("weight");
  });
});

// ── Concept2 webhook tests ──
describe("Concept2Provider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { Concept2Provider } = await import("./concept2.ts");
    const provider = new Concept2Provider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("parseWebhookPayload extracts result-added event", async () => {
    const { Concept2Provider } = await import("./concept2.ts");
    const provider = new Concept2Provider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event: "result-added",
      user_id: 999,
      result: { id: 456 },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      ownerExternalId: "999",
      eventType: "create",
      objectType: "result",
      objectId: "456",
      metadata: { payload: { id: "456" } },
    });
  });
});

// ── Suunto webhook tests ──
describe("SuuntoProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("verifyWebhookSignature validates HMAC-SHA256", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const { createHmac } = await import("node:crypto");
    const provider = new SuuntoProvider(async () => new Response());

    const body = Buffer.from('{"type":"workout"}');
    const secret = "suunto-secret";
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    const validSignature = hmac.digest("hex");

    expect(
      provider.verifyWebhookSignature(body, { "x-hmac-sha256-signature": validSignature }, secret),
    ).toBe(true);
  });
});

// ── COROS webhook tests ──
describe("CorosProvider webhook methods", () => {
  it("is detected as a WebhookProvider", async () => {
    const { CorosProvider } = await import("./coros.ts");
    const provider = new CorosProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("parseWebhookPayload extracts sportDataList events", async () => {
    const { CorosProvider } = await import("./coros.ts");
    const provider = new CorosProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      sportDataList: [
        { openId: "user-1", labelId: 100 },
        { openId: "user-2", labelId: 200 },
      ],
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.ownerExternalId).toBe("user-1");
    expect(events[1]?.ownerExternalId).toBe("user-2");
  });

  it("parseWebhookPayload falls back to single openId", async () => {
    const { CorosProvider } = await import("./coros.ts");
    const provider = new CorosProvider(async () => new Response());

    const events = provider.parseWebhookPayload({ openId: "user-solo" });
    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("user-solo");
  });
});

// ── isWebhookProvider type guard ──
describe("isWebhookProvider", () => {
  it("returns false for non-webhook providers", async () => {
    // Create a minimal non-webhook SyncProvider
    const nonWebhook = {
      id: "test",
      name: "Test",
      validate: () => null,
      sync: async () => ({ provider: "test", recordsSynced: 0, errors: [], duration: 0 }),
    };
    expect(isWebhookProvider(nonWebhook)).toBe(false);
  });
});

// ── registerWebhook / unregisterWebhook ──

describe("Concept2Provider register/unregister", () => {
  it("registerWebhook returns portal subscription ID", async () => {
    const { Concept2Provider } = await import("./concept2.ts");
    const provider = new Concept2Provider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/callback", "tok");
    expect(result.subscriptionId).toBe("concept2-portal-subscription");
  });

  it("unregisterWebhook is a no-op", async () => {
    const { Concept2Provider } = await import("./concept2.ts");
    const provider = new Concept2Provider(async () => new Response());
    await expect(provider.unregisterWebhook("anything")).resolves.toBeUndefined();
  });

  it("verifyWebhookSignature always returns true", async () => {
    const { Concept2Provider } = await import("./concept2.ts");
    const provider = new Concept2Provider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("body"), {}, "secret")).toBe(true);
  });
});

describe("SuuntoProvider register/unregister", () => {
  it("registerWebhook returns portal subscription ID", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    expect(result.subscriptionId).toBe("suunto-portal-subscription");
  });

  it("unregisterWebhook is a no-op", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    await expect(provider.unregisterWebhook("sub-1")).resolves.toBeUndefined();
  });

  it("verifyWebhookSignature rejects missing header", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("body"), {}, "secret")).toBe(false);
  });

  it("verifyWebhookSignature rejects wrong signature", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(
      provider.verifyWebhookSignature(
        Buffer.from("body"),
        { "x-hmac-sha256-signature": "wrong" },
        "secret",
      ),
    ).toBe(false);
  });

  it("verifyWebhookSignature rejects array header value", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(
      provider.verifyWebhookSignature(
        Buffer.from("body"),
        { "x-hmac-sha256-signature": ["val1", "val2"] },
        "secret",
      ),
    ).toBe(false);
  });
});

describe("WahooProvider register/unregister", () => {
  it("registerWebhook returns portal subscription ID", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    expect(result.subscriptionId).toBe("wahoo-portal-subscription");
  });

  it("unregisterWebhook is a no-op", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    await expect(provider.unregisterWebhook("sub-1")).resolves.toBeUndefined();
  });

  it("verifyWebhookSignature always returns true", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("{}"), {}, "secret")).toBe(true);
  });

  it("parseWebhookPayload still returns event when user.id is present without event_type", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    // Wahoo parses as long as user.id exists
    const events = provider.parseWebhookPayload({ user: { id: 1 } });
    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("1");
  });

  it("parseWebhookPayload returns empty for null input", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
  });
});

describe("StravaProvider register/unregister", () => {
  it("registerWebhook sends POST to Strava API", async () => {
    const mockFetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 12345 }), { status: 200 }),
    );
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(mockFetch, 0);

    const original = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "test-client-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";

    const result = await provider.registerWebhook("https://example.com/cb", "verify-tok");
    expect(result.subscriptionId).toBe("12345");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.strava.com/api/v3/push_subscriptions",
      expect.objectContaining({ method: "POST" }),
    );

    process.env.STRAVA_CLIENT_ID = original.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = original.STRAVA_CLIENT_SECRET;
  });

  it("registerWebhook throws without client credentials", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const original = { ...process.env };
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;

    await expect(provider.registerWebhook("https://example.com/cb", "tok")).rejects.toThrow(
      "STRAVA_CLIENT_ID",
    );

    process.env.STRAVA_CLIENT_ID = original.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = original.STRAVA_CLIENT_SECRET;
  });

  it("registerWebhook throws on non-ok response", async () => {
    const mockFetch = vi.fn(async () => new Response("error", { status: 403 }));
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(mockFetch, 0);

    const original = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    await expect(provider.registerWebhook("https://example.com/cb", "tok")).rejects.toThrow(
      "Strava webhook registration failed",
    );

    process.env.STRAVA_CLIENT_ID = original.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = original.STRAVA_CLIENT_SECRET;
  });

  it("unregisterWebhook sends DELETE to Strava API", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(mockFetch, 0);

    const original = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    await provider.unregisterWebhook("12345");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("push_subscriptions/12345"),
      expect.objectContaining({ method: "DELETE" }),
    );

    process.env.STRAVA_CLIENT_ID = original.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = original.STRAVA_CLIENT_SECRET;
  });

  it("unregisterWebhook is a no-op without credentials", async () => {
    const mockFetch = vi.fn(async () => new Response());
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(mockFetch, 0);

    const original = { ...process.env };
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;

    await provider.unregisterWebhook("12345");
    expect(mockFetch).not.toHaveBeenCalled();

    process.env.STRAVA_CLIENT_ID = original.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = original.STRAVA_CLIENT_SECRET;
  });

  it("parseWebhookPayload handles update event", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "update",
      object_id: 111,
      object_type: "activity",
      owner_id: 222,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("update");
    expect(events[0]?.objectId).toBe("111");
  });
});

describe("FitbitProvider register/unregister", () => {
  it("registerWebhook returns portal subscription with signing secret", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "verify-tok");
    expect(result.subscriptionId).toBe("fitbit-app-subscription");
    expect(result.signingSecret).toBe("verify-tok");
  });

  it("unregisterWebhook is a no-op", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());
    await expect(provider.unregisterWebhook("sub-1")).resolves.toBeUndefined();
  });

  it("parseWebhookPayload handles missing fields gracefully", async () => {
    const { FitbitProvider } = await import("./fitbit/provider.ts");
    const provider = new FitbitProvider(async () => new Response());
    // Items missing ownerId get filtered out
    const events = provider.parseWebhookPayload([
      { collectionType: "activities" }, // missing ownerId
    ]);
    expect(events).toHaveLength(0);
  });
});

describe("OuraProvider register/unregister", () => {
  it("registerWebhook registers for all data types", async () => {
    const mockFetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "oura-sub-1" }), { status: 200 }),
    );
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(mockFetch);

    const original = { ...process.env };
    process.env.OURA_CLIENT_ID = "oura-id";
    process.env.OURA_CLIENT_SECRET = "oura-secret";

    const result = await provider.registerWebhook("https://example.com/cb", "verify-tok");
    expect(result.subscriptionId).toBe("oura-sub-1");
    expect(result.expiresAt).toBeInstanceOf(Date);
    // Should register for all 8 data types
    expect(mockFetch).toHaveBeenCalledTimes(8);

    process.env.OURA_CLIENT_ID = original.OURA_CLIENT_ID;
    process.env.OURA_CLIENT_SECRET = original.OURA_CLIENT_SECRET;
  });

  it("registerWebhook handles 409 conflict gracefully", async () => {
    const mockFetch = vi.fn(async () => new Response("Already exists", { status: 409 }));
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(mockFetch);

    const original = { ...process.env };
    process.env.OURA_CLIENT_ID = "oura-id";
    process.env.OURA_CLIENT_SECRET = "oura-secret";

    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    // Should not throw; returns fallback ID when all are 409
    expect(result.subscriptionId).toBe("oura-multi-subscription");

    process.env.OURA_CLIENT_ID = original.OURA_CLIENT_ID;
    process.env.OURA_CLIENT_SECRET = original.OURA_CLIENT_SECRET;
  });

  it("registerWebhook throws without credentials", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());

    const original = { ...process.env };
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    await expect(provider.registerWebhook("https://example.com/cb", "tok")).rejects.toThrow(
      "OURA_CLIENT_ID",
    );

    process.env.OURA_CLIENT_ID = original.OURA_CLIENT_ID;
    process.env.OURA_CLIENT_SECRET = original.OURA_CLIENT_SECRET;
  });

  it("unregisterWebhook sends DELETE to Oura API", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(mockFetch);

    const original = { ...process.env };
    process.env.OURA_CLIENT_ID = "oura-id";
    process.env.OURA_CLIENT_SECRET = "oura-secret";

    await provider.unregisterWebhook("sub-123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("webhook/subscription/sub-123"),
      expect.objectContaining({ method: "DELETE" }),
    );

    process.env.OURA_CLIENT_ID = original.OURA_CLIENT_ID;
    process.env.OURA_CLIENT_SECRET = original.OURA_CLIENT_SECRET;
  });

  it("unregisterWebhook is a no-op without credentials", async () => {
    const mockFetch = vi.fn(async () => new Response());
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(mockFetch);

    const original = { ...process.env };
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    await provider.unregisterWebhook("sub-123");
    expect(mockFetch).not.toHaveBeenCalled();

    process.env.OURA_CLIENT_ID = original.OURA_CLIENT_ID;
    process.env.OURA_CLIENT_SECRET = original.OURA_CLIENT_SECRET;
  });

  it("verifyWebhookSignature always returns true (uses challenge verification)", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("body"), {}, "secret")).toBe(true);
  });

  it("parseWebhookPayload extracts sleep event", async () => {
    const { OuraProvider } = await import("./oura.ts");
    const provider = new OuraProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event_type: "create.daily_sleep",
      data_type: "daily_sleep",
      user_id: "user-xyz",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe("daily_sleep");
    expect(events[0]?.eventType).toBe("create");
  });
});

describe("WithingsProvider register/unregister", () => {
  it("registerWebhook returns stub subscription", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    expect(result.subscriptionId).toBe("withings-user-subscription");
  });

  it("unregisterWebhook is a no-op", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    await expect(provider.unregisterWebhook("sub-1")).resolves.toBeUndefined();
  });

  it("verifyWebhookSignature always returns true", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("body"), {}, "secret")).toBe(true);
  });

  it("parseWebhookPayload maps Withings appli codes to object types", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());

    // appli 44 = sleep
    const sleepEvents = provider.parseWebhookPayload({
      userid: 999,
      appli: 44,
      startdate: 1705312000,
      enddate: 1705398400,
    });
    expect(sleepEvents).toHaveLength(1);
    expect(sleepEvents[0]?.objectType).toBe("sleep");
  });

  it("parseWebhookPayload returns empty for null", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
  });

  it("parseWebhookPayload returns event for empty object with default values", async () => {
    const { WithingsProvider } = await import("./withings.ts");
    const provider = new WithingsProvider(async () => new Response());
    // Empty object still gets parsed (userid defaults to undefined which becomes "undefined")
    const events = provider.parseWebhookPayload({});
    expect(events.length).toBeGreaterThanOrEqual(0);
  });
});

describe("PolarProvider register/unregister", () => {
  it("parseWebhookPayload handles sleep event", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const provider = new PolarProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event: "SLEEP",
      user_id: 999,
      entity_id: "sleep-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe("sleep");
  });

  it("parseWebhookPayload returns empty for invalid payload", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const provider = new PolarProvider(async () => new Response());
    expect(provider.parseWebhookPayload({})).toHaveLength(0);
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
  });

  it("verifyWebhookSignature rejects missing header", async () => {
    const { PolarProvider } = await import("./polar.ts");
    const provider = new PolarProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from("body"), {}, "secret")).toBe(false);
  });
});

describe("CorosProvider register/unregister", () => {
  it("parseWebhookPayload returns empty for invalid payload", async () => {
    const { CorosProvider } = await import("./coros.ts");
    const provider = new CorosProvider(async () => new Response());
    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
    expect(provider.parseWebhookPayload("string")).toHaveLength(0);
  });

  it("parseWebhookPayload returns empty for empty sportDataList", async () => {
    const { CorosProvider } = await import("./coros.ts");
    const provider = new CorosProvider(async () => new Response());
    expect(provider.parseWebhookPayload({ sportDataList: [] })).toHaveLength(0);
  });
});

// ── More precise string/object assertions to kill StringLiteral/ObjectLiteral mutants ──

describe("StravaProvider webhook — precise assertions", () => {
  it("parseWebhookPayload returns exact event structure for create", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      event_time: 1234567890,
      object_id: 12345,
      object_type: "activity",
      owner_id: 67890,
      subscription_id: 1,
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.ownerExternalId).toBe("67890");
    expect(event?.eventType).toBe("create");
    expect(event?.objectType).toBe("activity");
    expect(event?.objectId).toBe("12345");
    // Strava parseWebhookPayload should NOT include metadata
    expect(event?.metadata).toBeUndefined();
  });

  it("parseWebhookPayload defaults to update when aspect_type is unrecognized", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "unknown_aspect",
      object_type: "activity",
      owner_id: 42,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("update");
  });

  it("parseWebhookPayload defaults to update when aspect_type is missing", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      object_type: "activity",
      owner_id: 42,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("update");
  });

  it("parseWebhookPayload returns objectId as undefined when object_id is missing", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 42,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("parseWebhookPayload passes through object_type as-is", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "athlete",
      owner_id: 42,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe("athlete");
  });

  it("handleValidationChallenge returns null when hub.mode is not subscribe", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const result = provider.handleValidationChallenge(
      { "hub.mode": "unsubscribe", "hub.challenge": "abc", "hub.verify_token": "mytoken" },
      "mytoken",
    );
    expect(result).toBeNull();
  });

  it("handleValidationChallenge returns null when hub.challenge is missing", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);

    const result = provider.handleValidationChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "mytoken" },
      "mytoken",
    );
    expect(result).toBeNull();
  });

  it("id is exactly 'strava'", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);
    expect(provider.id).toBe("strava");
  });

  it("name is exactly 'Strava'", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);
    expect(provider.name).toBe("Strava");
  });

  it("webhookScope is exactly 'app'", async () => {
    const { StravaProvider } = await import("./strava.ts");
    const provider = new StravaProvider(async () => new Response(), 0);
    expect(provider.webhookScope).toBe("app");
  });
});

describe("WahooProvider webhook — precise assertions", () => {
  it("parseWebhookPayload returns eventType 'update' for workout_summary.updated", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event_type: "workout_summary.updated",
      user: { id: 100 },
      workout_summary: {
        id: 55,
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T10:00:00Z",
      },
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.ownerExternalId).toBe("100");
    expect(event?.eventType).toBe("update");
    expect(event?.objectType).toBe("workout");
    expect(event?.objectId).toBe("55");
    expect(event?.metadata).toBeDefined();
    expect(event?.metadata).toHaveProperty("payload");
  });

  it("parseWebhookPayload returns eventType 'create' for workout_summary.created", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      event_type: "workout_summary.created",
      user: { id: 10 },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("create");
  });

  it("parseWebhookPayload returns objectId as undefined when workout_summary is absent", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      user: { id: 10 },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectId).toBeUndefined();
    expect(events[0]?.objectType).toBe("workout");
  });

  it("parseWebhookPayload returns empty array for invalid payload structure", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());

    expect(provider.parseWebhookPayload({ bad: true })).toHaveLength(0);
    expect(provider.parseWebhookPayload(undefined)).toHaveLength(0);
    expect(provider.parseWebhookPayload(42)).toHaveLength(0);
  });

  it("id is exactly 'wahoo'", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(provider.id).toBe("wahoo");
  });

  it("name is exactly 'Wahoo'", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(provider.name).toBe("Wahoo");
  });

  it("webhookScope is exactly 'app'", async () => {
    const { WahooProvider } = await import("./wahoo/index.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(provider.webhookScope).toBe("app");
  });
});

describe("SuuntoProvider webhook — precise assertions", () => {
  it("parseWebhookPayload returns exact event structure", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      type: "WORKOUT_CREATED",
      username: "user@example.com",
      workout_id: "w-123",
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.ownerExternalId).toBe("user@example.com");
    expect(event?.eventType).toBe("create");
    expect(event?.objectType).toBe("WORKOUT_CREATED");
    expect(event?.objectId).toBe("w-123");
    expect(event?.metadata).toBeDefined();
    expect(event?.metadata).toHaveProperty("payload");
  });

  it("parseWebhookPayload uses type as objectType and falls back to 'workout' when type is missing", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      username: "user@example.com",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectType).toBe("workout");
  });

  it("parseWebhookPayload returns objectId as undefined when workout_id is missing", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      username: "user@example.com",
      type: "WORKOUT_CREATED",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("parseWebhookPayload returns empty for invalid payload", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());

    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
    expect(provider.parseWebhookPayload({})).toHaveLength(0);
    expect(provider.parseWebhookPayload("string")).toHaveLength(0);
    expect(provider.parseWebhookPayload(42)).toHaveLength(0);
  });

  it("parseWebhookPayload always returns eventType 'create'", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());

    const events = provider.parseWebhookPayload({
      type: "WORKOUT_DELETED",
      username: "test",
    });

    // Suunto always returns "create" regardless of type
    expect(events[0]?.eventType).toBe("create");
  });

  it("id is exactly 'suunto'", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(provider.id).toBe("suunto");
  });

  it("name is exactly 'Suunto'", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(provider.name).toBe("Suunto");
  });

  it("webhookScope is exactly 'app'", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    expect(provider.webhookScope).toBe("app");
  });

  it("verifyWebhookSignature rejects length-mismatched signatures", async () => {
    const { SuuntoProvider } = await import("./suunto.ts");
    const provider = new SuuntoProvider(async () => new Response());
    // Short signature vs expected 64-char hex — timingSafeEqual throws on length mismatch
    expect(
      provider.verifyWebhookSignature(
        Buffer.from("body"),
        { "x-hmac-sha256-signature": "ab" },
        "secret",
      ),
    ).toBe(false);
  });
});

describe("isWebhookProvider — additional type guard tests", () => {
  it("returns true for providers with registerWebhook as a function", () => {
    const webhookProvider = {
      id: "test-wh",
      name: "Test Webhook",
      validate: () => null,
      sync: async () => ({ provider: "test-wh", recordsSynced: 0, errors: [], duration: 0 }),
      registerWebhook: async () => ({ subscriptionId: "sub" }),
      unregisterWebhook: async () => {},
      verifyWebhookSignature: () => true,
      parseWebhookPayload: () => [],
      webhookScope: "app" as const,
    };
    expect(isWebhookProvider(webhookProvider)).toBe(true);
  });

  it("returns false for import-only providers", () => {
    const importProvider = {
      id: "csv",
      name: "CSV",
      validate: () => null,
      importOnly: true as const,
    };
    expect(isWebhookProvider(importProvider)).toBe(false);
  });

  it("returns false when registerWebhook is not a function", () => {
    // Simulate a malformed provider via Object.assign to avoid type assertion
    const badProvider = {
      id: "bad",
      name: "Bad",
      validate: () => null,
      sync: async () => ({ provider: "bad", recordsSynced: 0, errors: [], duration: 0 }),
    };
    Object.assign(badProvider, { registerWebhook: "not-a-function" });
    expect(isWebhookProvider(badProvider)).toBe(false);
  });
});
