import { describe, expect, it } from "vitest";
import { InMemorySlackDedupeStore } from "./dedupe-store.ts";

describe("InMemorySlackDedupeStore", () => {
  it("claims a key once within TTL and allows it again after expiry", async () => {
    const store = new InMemorySlackDedupeStore();
    const key = "event:Ev123";

    const firstClaim = await store.claim(key, 25);
    const secondClaim = await store.claim(key, 25);

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const thirdClaim = await store.claim(key, 25);
    expect(thirdClaim).toBe(true);
  });
});
