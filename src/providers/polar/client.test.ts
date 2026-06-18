import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { PolarClient } from "./client.ts";

describe("PolarClient — empty JSON responses", () => {
  it("treats an empty 200 body as no daily activity data", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("", { status: 200 });

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
