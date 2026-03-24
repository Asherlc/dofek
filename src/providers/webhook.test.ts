import { describe, expect, it } from "vitest";
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
    const { FitbitProvider } = await import("./fitbit.ts");
    const provider = new FitbitProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
    expect(provider.webhookScope).toBe("app");
  });

  it("parseWebhookPayload extracts notifications array", async () => {
    const { FitbitProvider } = await import("./fitbit.ts");
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
    const { FitbitProvider } = await import("./fitbit.ts");
    const provider = new FitbitProvider(async () => new Response());
    expect(provider.parseWebhookPayload({})).toHaveLength(0);
  });

  it("parseWebhookPayload filters out invalid items", async () => {
    const { FitbitProvider } = await import("./fitbit.ts");
    const provider = new FitbitProvider(async () => new Response());

    const events = provider.parseWebhookPayload([
      { collectionType: "activities", ownerId: "ABC" },
      { bad: "data" },
      null,
    ]);

    expect(events).toHaveLength(1);
  });

  it("verifyWebhookSignature validates HMAC-SHA1", async () => {
    const { FitbitProvider } = await import("./fitbit.ts");
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
    const { FitbitProvider } = await import("./fitbit.ts");
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
    const { WahooProvider } = await import("./wahoo.ts");
    const provider = new WahooProvider(async () => new Response());
    expect(isWebhookProvider(provider)).toBe(true);
  });

  it("parseWebhookPayload extracts workout event", async () => {
    const { WahooProvider } = await import("./wahoo.ts");
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
