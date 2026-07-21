import { describe, expect, it } from "vitest";
import { InMemoryMobileAuthExchangeStore } from "./mobile-auth-exchange-store.ts";

describe("InMemoryMobileAuthExchangeStore", () => {
  it("consumes a code only once", async () => {
    const store = new InMemoryMobileAuthExchangeStore();
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });

    await expect(store.consume(code)).resolves.toEqual({
      kind: "session",
      sessionId: "session-1",
      isNewUser: false,
    });
    await expect(store.consume(code)).resolves.toBeNull();
  });

  it("rejects expired codes", async () => {
    const store = new InMemoryMobileAuthExchangeStore({ ttlMs: 1 });
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(store.consume(code)).resolves.toBeNull();
  });
});
