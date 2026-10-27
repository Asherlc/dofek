import { describe, expect, it } from "vitest";
import {
  openAccountErasureRestoreIntent,
  sealAccountErasureRestoreIntent,
} from "./restore-intent-codec.ts";

const intent = {
  keyId: "test-v1",
  requestId: "10000000-0000-4000-8000-000000001994",
  requestedAt: "2026-07-26T12:00:00.000Z",
  statusToken: "s".repeat(43),
  userHash: "a".repeat(64),
};

describe("account erasure restore intent codec", () => {
  it("round-trips the status token without storing it in plaintext", () => {
    const sealed = sealAccountErasureRestoreIntent(intent);

    expect(JSON.stringify(sealed)).not.toContain(intent.statusToken);
    expect(openAccountErasureRestoreIntent(sealed)).toEqual(intent);
  });

  it("rejects ciphertext tampering", () => {
    const sealed = sealAccountErasureRestoreIntent(intent);

    expect(() =>
      openAccountErasureRestoreIntent({
        ...sealed,
        encryptedStatusToken: Buffer.from("tampered").toString("base64"),
      }),
    ).toThrow();
  });

  it("binds the ciphertext to request and user metadata", () => {
    const sealed = sealAccountErasureRestoreIntent(intent);

    expect(() =>
      openAccountErasureRestoreIntent({
        ...sealed,
        userHash: "b".repeat(64),
      }),
    ).toThrow();
  });

  it("rejects raw identity or health fields from the narrow deletion ledger", () => {
    const forbiddenIntent = {
      ...intent,
      email: "person@example.test",
      healthData: { heartRate: 72 },
      providerCredential: "provider-secret",
      userId: "20000000-0000-4000-8000-000000001994",
    };

    expect(() => sealAccountErasureRestoreIntent(forbiddenIntent)).toThrow();
  });

  it("decrypts intents written with a retained pre-rotation key", () => {
    const oldIntent = { ...intent, keyId: "test-v0" };

    expect(openAccountErasureRestoreIntent(sealAccountErasureRestoreIntent(oldIntent))).toEqual(
      oldIntent,
    );
  });
});
