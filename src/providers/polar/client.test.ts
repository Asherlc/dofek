import { describe, expect, it } from "vitest";
import { PolarClient } from "./client.ts";

describe("PolarClient — empty JSON responses", () => {
  it("treats an empty 200 body as no daily activity data", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getDailyActivity()).resolves.toEqual([]);
  });

  it("treats a whitespace-only 200 body as no daily activity data", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("  \n", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getDailyActivity()).resolves.toEqual([]);
  });

  it("treats an empty 200 body as no exercises", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).resolves.toEqual([]);
  });

  it("treats an empty 200 body as no sleep data", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getSleep()).resolves.toEqual([]);
  });

  it("treats an empty 200 body as no nightly recharge data", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getNightlyRecharge()).resolves.toEqual([]);
  });
});

describe("PolarClient — response parsing", () => {
  it("parses a JSON array response", async () => {
    const exercises = [{ id: "abc", sport: "RUNNING" }];
    const fetchFn: typeof globalThis.fetch = async () => Response.json(exercises);

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).resolves.toEqual(exercises);
  });

  it("throws when a successful response contains invalid JSON", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("{not-json", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow(
      "Polar API returned invalid JSON for /exercises:",
    );
  });

  it("throws when a successful response has the wrong JSON shape", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({ nights: [] });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /exercises",
    );
  });

  it("throws when daily activity response is not an array", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({ days: [] });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getDailyActivity()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/activities",
    );
  });

  it("throws when sleep response is not an object", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json("not-an-object");

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getSleep()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/sleep",
    );
  });

  it("throws when sleep response is missing nights", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({});

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getSleep()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/sleep",
    );
  });

  it("throws when sleep nights is not an array", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({ nights: "bad" });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getSleep()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/sleep",
    );
  });

  it("throws when nightly recharge response is not an object", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json(null);

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getNightlyRecharge()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/nightly-recharge",
    );
  });

  it("throws when nightly recharge response is missing recharges", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({});

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getNightlyRecharge()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/nightly-recharge",
    );
  });

  it("throws when nightly recharge recharges is not an array", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({ recharges: "bad" });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getNightlyRecharge()).rejects.toThrow(
      "Polar API returned unexpected JSON shape for /users/nightly-recharge",
    );
  });

  it("preserves the JSON parse error as the cause", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("{not-json", { status: 200 });

    const client = new PolarClient("access-token", fetchFn);

    try {
      await client.getExercises();
      expect.unreachable("expected invalid JSON to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        return;
      }
      expect(error.cause).toBeInstanceOf(SyntaxError);
    }
  });
});

describe("PolarClient — API error responses", () => {
  it("includes JSON error bodies in API error messages", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response('{"message":"bad"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow('Polar API error (500): {"message":"bad"}');
  });

  it("handles API errors with JSON content-type but empty body", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("", {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow(
      "Polar API error (500): (empty JSON error body)",
    );
  });

  it("redacts HTML error pages from API error messages", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("<html>error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow("Polar API error (500): (HTML error page)");
  });

  it("includes plain-text error bodies in API error messages", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("upstream unavailable", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });

    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toThrow(
      "Polar API error (500): upstream unavailable",
    );
  });
});

describe("PolarClient — rate-limit aware fetch wiring", () => {
  it("throws a ProviderRateLimitError tagged with providerId 'polar' on a 429", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "60" } });

    // The constructor wraps fetchFn with createRateLimitAwareFetch({ providerId: "polar" }),
    // so a 429 from any request must surface as a tagged ProviderRateLimitError.
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.getExercises()).rejects.toMatchObject({
      providerId: "polar",
      retryAfterSeconds: 60,
    });
    await expect(client.getExercises()).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});
