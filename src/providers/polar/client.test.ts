import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
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

describe("PolarClient — service unavailable responses", () => {
  it("throws a polar-scoped ProviderServiceUnavailableError for a JSON 500 response", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response('{"message":"bad"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const client = new PolarClient("access-token", fetchFn);

    const error = await client.getExercises().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      providerId: "polar",
      statusCode: 500,
      responseBody: '{"message":"bad"}',
    });
  });

  it("throws a polar-scoped ProviderServiceUnavailableError for an empty JSON 500 response", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("", {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const client = new PolarClient("access-token", fetchFn);

    const error = await client.getExercises().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      providerId: "polar",
      statusCode: 500,
      responseBody: "",
    });
  });

  it("throws a polar-scoped ProviderServiceUnavailableError for an HTML 500 response", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("<html>error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });

    const client = new PolarClient("access-token", fetchFn);

    const error = await client.getExercises().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      providerId: "polar",
      statusCode: 500,
      responseBody: "<html>error</html>",
    });
  });

  it("throws a polar-scoped ProviderServiceUnavailableError for a text 500 response", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("upstream unavailable", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });

    const client = new PolarClient("access-token", fetchFn);

    const error = await client.getExercises().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      providerId: "polar",
      statusCode: 500,
      responseBody: "upstream unavailable",
    });
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

describe("PolarClient — durable account-erasure deregistration", () => {
  it("accepts Polar's documented absent response without issuing DELETE", async () => {
    const requests: { method: string; url: string; headers: HeadersInit | undefined }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      requests.push({
        headers: init?.headers,
        method: init?.method ?? "GET",
        url: String(url),
      });
      return new Response(null, { status: 204 });
    };
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer access-token",
        },
        method: "GET",
        url: "https://www.polaraccesslink.com/v3/users/12345",
      },
    ]);
  });

  it("deletes a registered user and accepts only the documented 204 success", async () => {
    const requests: { method: string; url: string; headers: HeadersInit | undefined }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ headers: init?.headers, method, url: String(url) });
      return new Response(null, { status: method === "GET" ? 200 : 204 });
    };
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer access-token",
        },
        method: "GET",
        url: "https://www.polaraccesslink.com/v3/users/12345",
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer access-token",
        },
        method: "DELETE",
        url: "https://www.polaraccesslink.com/v3/users/12345",
      },
    ]);
  });

  it("accepts the exact OAuth invalid_token challenge on replay", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="polar", error="invalid_token"',
        },
      });
    const client = new PolarClient("revoked-access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
  });

  it("accepts an invalid_token race after registration was confirmed", async () => {
    const fetchFn: typeof globalThis.fetch = async (_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer realm="polar", error="invalid_token"',
            },
          })
        : new Response(null, { status: 200 });
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
  });

  it("rejects a bare 401 because it does not prove token revocation", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401 });
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).rejects.toThrow(
      "registration check failed (401)",
    );
  });

  it("rejects undocumented not-found responses", async () => {
    const fetchFn: typeof globalThis.fetch = async (_url, init) =>
      new Response("Not found", { status: init?.method === "DELETE" ? 404 : 200 });
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).rejects.toThrow(
      "deregistration failed (404)",
    );
    await expect(client.deregisterUser("12345")).rejects.toThrow("deregistration failed (404)");
  });

  it.each([
    ['Bearer error="invalid_token"', true],
    ['bearer realm="polar", error="invalid_token"', true],
    ['Bearer realm="polar",error="invalid_token",scope="read"', true],
    ['Bearer realm="polar", error="invalid_tokenized"', false],
    ['Bearer realm="polar", error="invalid_token" extra', false],
    ['Basic realm="polar", error="invalid_token"', false],
  ])("handles an OAuth challenge %s", async (challenge, accepted) => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": challenge },
      });
    const client = new PolarClient("access-token", fetchFn);

    if (accepted) {
      await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
    } else {
      await expect(client.deregisterUserForAccountErasure("12345")).rejects.toThrow(
        "registration check failed (401)",
      );
    }
  });

  it("accepts a challenge with surrounding whitespace", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="polar", error="invalid_token"',
        },
      });
    const client = new PolarClient("access-token", fetchFn);

    await expect(client.deregisterUserForAccountErasure("12345")).resolves.toBeUndefined();
  });
});
