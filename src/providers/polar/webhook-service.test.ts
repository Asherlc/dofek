import { createHmac } from "node:crypto";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolarWebhookService } from "./webhook-service.ts";

const CALLBACK_URL = "https://dofek.example.com/webhook";

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

describe("PolarWebhookService.registerWebhook", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("POSTs the webhook subscription with JSON headers and the three Polar events", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      captured.push({
        url: String(url),
        method: init?.method,
        headers: toHeaderRecord(init?.headers),
        body: init?.body ?? null,
      });
      return Response.json({ data: { id: "sub-123", signature_secret_key: "secret-key" } });
    };

    const service = new PolarWebhookService(fetchFn);
    const result = await service.registerWebhook(CALLBACK_URL);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) throw new Error("Expected a captured request");

    expect(request.url).toBe("https://www.polaraccesslink.com/v3/webhooks");
    expect(request.method).toBe("POST");

    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("polar-id:polar-secret").toString("base64")}`,
    );

    const parsedBody: { events: Array<{ event: string; url: string }> } = JSON.parse(
      String(request.body),
    );
    expect(parsedBody.events).toEqual([
      { event: "EXERCISE", url: CALLBACK_URL },
      { event: "SLEEP", url: CALLBACK_URL },
      { event: "CONTINUOUS_HEART_RATE", url: CALLBACK_URL },
    ]);

    expect(result.subscriptionId).toBe("sub-123");
    expect(result.signingSecret).toBe("secret-key");
  });

  it("falls back to a default subscription id when the response omits data.id", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({});
    const service = new PolarWebhookService(fetchFn);

    const result = await service.registerWebhook(CALLBACK_URL);
    expect(result.subscriptionId).toBe("polar-webhook");
    expect(result.signingSecret).toBeUndefined();
  });

  it("throws when neither POLAR_CLIENT_ID nor POLAR_CLIENT_SECRET is set", async () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;

    let fetchCalled = false;
    const fetchFn: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      return Response.json({});
    };

    const service = new PolarWebhookService(fetchFn);
    await expect(service.registerWebhook(CALLBACK_URL)).rejects.toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
    expect(fetchCalled).toBe(false);
  });

  it("throws when only POLAR_CLIENT_ID is set", async () => {
    delete process.env.POLAR_CLIENT_SECRET;

    const service = new PolarWebhookService(async () => Response.json({}));
    await expect(service.registerWebhook(CALLBACK_URL)).rejects.toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("throws when only POLAR_CLIENT_SECRET is set", async () => {
    delete process.env.POLAR_CLIENT_ID;

    const service = new PolarWebhookService(async () => Response.json({}));
    await expect(service.registerWebhook(CALLBACK_URL)).rejects.toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("throws with the status and body when registration is not ok", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("bad request body", { status: 400 });

    const service = new PolarWebhookService(fetchFn);
    await expect(service.registerWebhook(CALLBACK_URL)).rejects.toThrow(
      "Polar webhook registration failed (400): bad request body",
    );
  });

  it("throws the common rate-limit error when Polar responds 429", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "75" } });

    const service = new PolarWebhookService(fetchFn);
    try {
      await service.registerWebhook(CALLBACK_URL);
      throw new Error("Expected provider rate-limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitError);
      expect(error).toMatchObject({ providerId: "polar", retryAfterSeconds: 75 });
    }
  });
});

describe("PolarWebhookService.unregisterWebhook", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends DELETE to the subscription URL with the basic auth header", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      captured.push({
        url: String(url),
        method: init?.method,
        headers: toHeaderRecord(init?.headers),
      });
      return new Response(null, { status: 204 });
    };

    const service = new PolarWebhookService(fetchFn);
    await service.unregisterWebhook("sub-123");

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) throw new Error("Expected a captured request");
    expect(request.url).toBe("https://www.polaraccesslink.com/v3/webhooks/sub-123");
    expect(request.method).toBe("DELETE");
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("polar-id:polar-secret").toString("base64")}`,
    );
  });

  it("does nothing when credentials are missing", async () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;

    let fetchCalled = false;
    const fetchFn: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    const service = new PolarWebhookService(fetchFn);
    await service.unregisterWebhook("sub-123");
    expect(fetchCalled).toBe(false);
  });

  it("throws the common rate-limit error when Polar responds 429", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "30" } });

    const service = new PolarWebhookService(fetchFn);
    try {
      await service.unregisterWebhook("sub-123");
      throw new Error("Expected provider rate-limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitError);
      expect(error).toMatchObject({ providerId: "polar", retryAfterSeconds: 30 });
    }
  });
});

describe("PolarWebhookService.verifyWebhookSignature", () => {
  const signingSecret = "polar-signing-secret";
  const rawBody = Buffer.from('{"event":"EXERCISE"}');

  function signatureFor(body: Buffer, secret: string): string {
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    return hmac.digest("hex");
  }

  const service = new PolarWebhookService(async () => Response.json({}));

  it("returns true for a valid signature", () => {
    const signature = signatureFor(rawBody, signingSecret);
    const result = service.verifyWebhookSignature(
      rawBody,
      { "polar-webhook-signature": signature },
      signingSecret,
    );
    expect(result).toBe(true);
  });

  it("returns false for an invalid signature of equal length", () => {
    const valid = signatureFor(rawBody, signingSecret);
    // Flip the first hex character so the length stays equal (timingSafeEqual requires equal length).
    const tampered = `${valid[0] === "0" ? "1" : "0"}${valid.slice(1)}`;
    const result = service.verifyWebhookSignature(
      rawBody,
      { "polar-webhook-signature": tampered },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it("returns false when the signature length differs (timingSafeEqual throws)", () => {
    const result = service.verifyWebhookSignature(
      rawBody,
      { "polar-webhook-signature": "short" },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it("returns false when the signature header is missing", () => {
    const result = service.verifyWebhookSignature(rawBody, {}, signingSecret);
    expect(result).toBe(false);
  });

  it("returns false when the signature header is undefined", () => {
    const result = service.verifyWebhookSignature(
      rawBody,
      { "polar-webhook-signature": undefined },
      signingSecret,
    );
    expect(result).toBe(false);
  });

  it("returns false when the signature header is an array (non-string)", () => {
    const result = service.verifyWebhookSignature(
      rawBody,
      { "polar-webhook-signature": ["a", "b"] },
      signingSecret,
    );
    expect(result).toBe(false);
  });
});

describe("PolarWebhookService.parseWebhookPayload", () => {
  const service = new PolarWebhookService(async () => Response.json({}));

  it("maps EXERCISE events to the activity object type", () => {
    const events = service.parseWebhookPayload({
      event: "EXERCISE",
      user_id: 12345,
      entity_id: "exercise-1",
      timestamp: "2024-06-15T08:00:00Z",
    });
    expect(events).toEqual([
      {
        ownerExternalId: "12345",
        eventType: "create",
        objectType: "activity",
        objectId: "exercise-1",
      },
    ]);
  });

  it("maps SLEEP events to the sleep object type", () => {
    const events = service.parseWebhookPayload({
      event: "SLEEP",
      user_id: "777",
      entity_id: "sleep-1",
    });
    expect(events[0]?.objectType).toBe("sleep");
  });

  it("maps CONTINUOUS_HEART_RATE events to the heart_rate object type", () => {
    const events = service.parseWebhookPayload({
      event: "CONTINUOUS_HEART_RATE",
      user_id: "777",
      entity_id: "hr-1",
    });
    expect(events[0]?.objectType).toBe("heart_rate");
  });

  it("lowercases unmapped event types as the object type", () => {
    const events = service.parseWebhookPayload({
      event: "CUSTOM_EVENT",
      user_id: "777",
    });
    expect(events[0]?.objectType).toBe("custom_event");
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("returns an empty array when the payload fails schema validation", () => {
    expect(service.parseWebhookPayload({ user_id: "777" })).toEqual([]);
    expect(service.parseWebhookPayload(null)).toEqual([]);
    expect(service.parseWebhookPayload({ event: 123, user_id: "777" })).toEqual([]);
  });
});
