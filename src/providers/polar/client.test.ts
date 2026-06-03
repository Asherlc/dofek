import { describe, expect, it } from "vitest";
import { PolarClient, PolarNotFoundError, PolarUnauthorizedError } from "./client.ts";
import { sampleDailyActivity, sampleNightlyRecharge, sampleSleep } from "./test-helpers.ts";

describe("PolarClient", () => {
  it("throws PolarNotFoundError for 404 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html>Not Found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(PolarNotFoundError);
  });

  it("includes endpoint path in PolarNotFoundError message", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("", { status: 404 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow("/exercises");
  });

  it("throws PolarUnauthorizedError for 401 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(PolarUnauthorizedError);
  });

  it("truncates HTML error bodies instead of dumping them", async () => {
    const longHtml = `<!DOCTYPE html><html><head><title>Error</title></head><body>${"x".repeat(5000)}</body></html>`;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longHtml, {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow("(HTML error page)");
  });

  it("includes JSON body in error messages", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(
      'Polar API error (422): {"error":"unauthorized"}',
    );
  });

  it("parses successful JSON responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    const result = await client.getExercises();
    expect(result).toEqual([]);
  });

  it("requests sleep from Polar's user sleep endpoint and unwraps nights", async () => {
    let capturedUrl: string | null = null;
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(url);
      return Response.json({ nights: [sampleSleep] });
    };

    const client = new PolarClient("token", mockFetch);
    const result = await client.getSleep();

    expect(capturedUrl).toBe("https://www.polaraccesslink.com/v3/users/sleep");
    expect(result).toEqual([sampleSleep]);
  });

  it("requests daily activity from Polar's user activities endpoint", async () => {
    let capturedUrl: string | null = null;
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(url);
      return Response.json([sampleDailyActivity]);
    };

    const client = new PolarClient("token", mockFetch);
    const result = await client.getDailyActivity();

    expect(capturedUrl).toBe("https://www.polaraccesslink.com/v3/users/activities");
    expect(result).toEqual([sampleDailyActivity]);
  });

  it("requests nightly recharge from Polar's user endpoint and unwraps recharges", async () => {
    let capturedUrl: string | null = null;
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(url);
      return Response.json({ recharges: [sampleNightlyRecharge] });
    };

    const client = new PolarClient("token", mockFetch);
    const result = await client.getNightlyRecharge();

    expect(capturedUrl).toBe("https://www.polaraccesslink.com/v3/users/nightly-recharge");
    expect(result).toEqual([sampleNightlyRecharge]);
  });

  it("truncates long plain-text error responses", async () => {
    const longText = "x".repeat(300);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longText, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(
      `Polar API error (500): ${"x".repeat(200)}…`,
    );
  });
});

describe("PolarClient.registerUser", () => {
  it("sends POST /v3/users with member-id", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(null, { status: 200 });
    };

    const client = new PolarClient("token", mockFetch);
    await client.registerUser("12345");

    expect(capturedBody).toBe(JSON.stringify({ "member-id": "12345" }));
  });

  it("treats 409 Conflict as success (already registered)", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Conflict", { status: 409 });
    };

    const client = new PolarClient("token", mockFetch);
    // Should not throw
    await client.registerUser("12345");
  });

  it("throws on non-2xx/non-409 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Bad Request", { status: 400 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.registerUser("12345")).rejects.toThrow(
      "Polar user registration failed (400)",
    );
  });
});

describe("PolarClient.deregisterUser", () => {
  it("sends DELETE /v3/users/{userId}", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(url);
      capturedMethod = init?.method;
      return new Response(null, { status: 204 });
    };

    const client = new PolarClient("token", mockFetch);
    await client.deregisterUser("12345");

    expect(capturedUrl).toBe("https://www.polaraccesslink.com/v3/users/12345");
    expect(capturedMethod).toBe("DELETE");
  });

  it("treats 404 as success (already deregistered)", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new PolarClient("token", mockFetch);
    // Should not throw
    await client.deregisterUser("12345");
  });

  it("throws with truncated body on non-success responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Bad Request: missing field", { status: 400 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.deregisterUser("12345")).rejects.toThrow(
      "Polar user deregistration failed (400): Bad Request: missing field",
    );
  });

  it("truncates HTML error bodies", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.deregisterUser("12345")).rejects.toThrow(
      "Polar user deregistration failed (500): (HTML error page)",
    );
  });
});

describe("PolarClient.getCurrentUserId", () => {
  it("returns polar_user_id from GET /v3/users", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ polar_user_id: 12345 });
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBe("12345");
  });

  it("returns null when request fails", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBeNull();
  });

  it("returns null when polar_user_id is missing from response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({});
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBeNull();
  });
});

describe("PolarNotFoundError", () => {
  it("has correct name and message", () => {
    const error = new PolarNotFoundError("Not found");
    expect(error.name).toBe("PolarNotFoundError");
    expect(error.message).toBe("Not found");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("PolarUnauthorizedError", () => {
  it("has correct name and message", () => {
    const error = new PolarUnauthorizedError("Unauthorized");
    expect(error.name).toBe("PolarUnauthorizedError");
    expect(error.message).toBe("Unauthorized");
    expect(error).toBeInstanceOf(Error);
  });
});
