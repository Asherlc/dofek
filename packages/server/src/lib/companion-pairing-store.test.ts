import { describe, expect, it } from "vitest";
import {
  COMPANION_PAIRING_TTL_MS,
  InMemoryCompanionPairingStore,
  normalizePairingCode,
  PAIRING_SHORT_CODE_PATTERN,
  parsePairingCodeInput,
} from "./companion-pairing-store.ts";

describe("InMemoryCompanionPairingStore", () => {
  it("creates retrievable pairing challenges", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");

    const challenge = await store.createChallenge(now);

    expect(challenge.id).toHaveLength(32);
    expect(challenge.shortCode).toMatch(PAIRING_SHORT_CODE_PATTERN);
    expect(await store.getById(challenge.id, now)).toEqual(challenge);
    expect(await store.getByShortCode(challenge.shortCode, now)).toEqual(challenge);
    expect(new Date(challenge.expiresAt).getTime() - now.getTime()).toBe(COMPANION_PAIRING_TTL_MS);
  });

  it("normalizes codes entered with spaces or dashes", () => {
    expect(normalizePairingCode("ab c-123")).toBe("ABC123");
  });

  it("rejects short codes outside the generated alphabet", () => {
    expect(parsePairingCodeInput("ab c-234")).toBe("ABC234");
    expect(parsePairingCodeInput("I0O1AA")).toBeNull();
  });

  it("claims an unexpired challenge once", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    const claimed = await store.claimChallenge({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
      now,
    });

    expect(claimed).toMatchObject({
      id: challenge.id,
      userId: "user-1",
      companionToken: "dofek_companion_test",
      claimedAt: now.toISOString(),
    });
    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-2",
        companionToken: "dofek_companion_second",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("expires stale challenges", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    const expiredAt = new Date(now.getTime() + COMPANION_PAIRING_TTL_MS + 1);

    expect(await store.getById(challenge.id, expiredAt)).toBeNull();
    expect(await store.getByShortCode(challenge.shortCode, expiredAt)).toBeNull();
  });
});
