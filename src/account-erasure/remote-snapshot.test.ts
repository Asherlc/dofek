import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type AccountErasureRemoteSnapshot,
  accountErasureRemoteSnapshotSchema,
  decryptAccountErasureSnapshot,
} from "./remote-snapshot.ts";
import { AccountErasureSnapshotBudgetError } from "./snapshot-budget.ts";

vi.mock("../providers/index.ts", () => ({ getAllProviders: () => [] }));

const decryptCredentialValue = vi.fn();
vi.mock("../security/credential-encryption.ts", () => ({
  encryptCredentialValue: vi.fn(),
  decryptCredentialValue: (...args: unknown[]) => decryptCredentialValue(...args),
}));

const snapshotBudgetError = /Account deletion snapshot exceeds.*(?:limit|budget).*Contact support/;

function revocationConnection(overrides: {
  accessToken: string;
  refreshToken?: string | null;
  providerAccountId?: string;
  providerId?: string;
}): AccountErasureRemoteSnapshot["providerConnections"][number] {
  return {
    disposition: "revocation_credentials",
    accessToken: overrides.accessToken,
    refreshToken: overrides.refreshToken ?? null,
    providerAccountId: overrides.providerAccountId,
    providerId: overrides.providerId ?? "fixture-provider",
    expiresAt: "2026-11-05T00:00:00.000Z",
    scopes: null,
  };
}

function snapshot(): AccountErasureRemoteSnapshot {
  return {
    appleCredentials: [],
    authIdentities: [],
    externalEffects: [],
    localIdentifiers: {
      exportObjects: [],
      fileUploads: [],
      sessionIds: [],
      userId: randomUUID(),
    },
    posthogDistinctId: randomUUID(),
    processorEmails: [],
    providerConnections: [],
    stripe: null,
    webhooks: [],
  };
}

function fileUpload(encodedBytes: number) {
  const upload = {
    importJobId: null,
    multipartUploadId: null,
    objectKey: "",
    uploadId: randomUUID(),
  };
  const overhead = Buffer.byteLength(JSON.stringify(upload), "utf8");
  return { ...upload, objectKey: "x".repeat(encodedBytes - overhead) };
}

type RetainedListFixture = [string, (value: AccountErasureRemoteSnapshot, count: number) => void];
const retainedLists: RetainedListFixture[] = [
  [
    "auth identities",
    (value, count) => {
      value.authIdentities = Array.from({ length: count }, (_, index) => ({
        authProvider: "fixture",
        providerAccountId: `account-${index}`,
        email: null,
      }));
    },
  ],
  [
    "Apple credentials",
    (value, count) => {
      value.appleCredentials = Array.from({ length: count }, (_, index) => ({
        accessToken: "token",
        clientId: "client",
        providerAccountId: `account-${index}`,
        refreshToken: null,
      }));
    },
  ],
  [
    "external effects",
    (value, count) => {
      value.externalEffects = Array.from({ length: count }, (_, index) => ({
        system: "stripe",
        resourceType: "customer",
        externalId: `customer-${index}`,
        contactEmail: null,
      }));
    },
  ],
  [
    "processor emails",
    (value, count) => {
      value.processorEmails = Array.from(
        { length: count },
        (_, index) => `person-${index}@example.test`,
      );
    },
  ],
  [
    "provider connections",
    (value, count) => {
      value.providerConnections = Array.from({ length: count }, (_, index) => ({
        disposition: "no_remote_authorization",
        providerId: `provider-${index}`,
      }));
    },
  ],
  [
    "webhooks",
    (value, count) => {
      value.webhooks = Array.from({ length: count }, (_, index) => ({
        providerId: `provider-${index}`,
        subscriptionExternalId: `subscription-${index}`,
      }));
    },
  ],
  [
    "sessions",
    (value, count) => {
      value.localIdentifiers.sessionIds = Array.from(
        { length: count },
        (_, index) => `session-${index}`,
      );
    },
  ],
  [
    "uploads",
    (value, count) => {
      value.localIdentifiers.fileUploads = Array.from({ length: count }, () => fileUpload(256));
    },
  ],
  [
    "exports",
    (value, count) => {
      value.localIdentifiers.exportObjects = Array.from({ length: count }, () => ({
        exportId: randomUUID(),
        objectKey: "export/fixture",
      }));
    },
  ],
];

describe("account erasure retained snapshot budgets", () => {
  it.each(retainedLists)(
    "accepts 128 %s and rejects another entry with an actionable error",
    (_label, populate) => {
      const value = snapshot();
      populate(value, 128);
      expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
      populate(value, 129);
      expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
    },
  );

  it.each(["é", "\n"])(
    "measures serialized session bytes for %j rather than characters",
    (character) => {
      const value = snapshot();
      value.localIdentifiers.sessionIds = [character.repeat(2047)];
      expect(Buffer.byteLength(JSON.stringify(value.localIdentifiers.sessionIds[0]), "utf8")).toBe(
        4096,
      );
      expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
      value.localIdentifiers.sessionIds[0] += character;
      expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
    },
  );

  it("accepts a 4 KiB serialized upload item and rejects the next byte", () => {
    const value = snapshot();
    value.localIdentifiers.fileUploads = [fileUpload(4096)];
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    value.localIdentifiers.fileUploads[0] = fileUpload(4097);
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
  });

  it("enforces the combined local-list envelope when every item fits", () => {
    const value = snapshot();
    value.localIdentifiers.fileUploads = [
      ...Array.from({ length: 15 }, () => fileUpload(4096)),
      fileUpload(4075),
    ];
    const localListBytes = (input: AccountErasureRemoteSnapshot) =>
      [
        input.localIdentifiers.fileUploads,
        input.localIdentifiers.exportObjects,
        input.localIdentifiers.sessionIds,
      ].reduce((bytes, entries) => bytes + Buffer.byteLength(JSON.stringify(entries), "utf8"), 0);
    expect(localListBytes(value)).toBe(65536);
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    value.localIdentifiers.fileUploads[15] = fileUpload(4076);
    expect(localListBytes(value)).toBe(65537);
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
  });

  it("rejects a decoded credential field exceeding 64 KiB", () => {
    const value = snapshot();
    const credential = {
      accessToken: "x".repeat(65536),
      clientId: "fixture",
      providerAccountId: "fixture",
      refreshToken: null,
    };
    value.appleCredentials = [credential];
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    credential.accessToken += "x";
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
  });

  it("rejects a combined decoded credential budget even when each field fits", () => {
    const value = snapshot();
    value.appleCredentials = Array.from({ length: 8 }, (_, index) => ({
      accessToken: "x".repeat(65536),
      clientId: "fixture",
      providerAccountId: `fixture-${index}`,
      refreshToken: null,
    }));
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    value.appleCredentials.push({
      accessToken: "x",
      clientId: "fixture",
      providerAccountId: "another",
      refreshToken: null,
    });
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
  });

  it("checks the complete serialized snapshot before encryption", () => {
    const value = snapshot();
    value.stripe = { customerId: "", subscriptionId: null };
    const overhead = Buffer.byteLength(JSON.stringify(value), "utf8");
    value.stripe.customerId = "x".repeat(1048576 - overhead);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(1048576);
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    value.stripe.customerId += "x";
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);
  });

  it("reports the overflowing top-level array on the Zod issue path", () => {
    const value = snapshot();
    value.authIdentities = Array.from({ length: 129 }, (_, index) => ({
      authProvider: "fixture",
      providerAccountId: `account-${index}`,
      email: null,
    }));
    const parsed = accountErasureRemoteSnapshotSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected budget failure");
    expect(parsed.error.issues[0]?.path).toEqual(["authIdentities"]);
    expect(parsed.error.issues[0]?.message).toMatch(snapshotBudgetError);
  });

  it("reports overflowing local lists under localIdentifiers on the Zod issue path", () => {
    const value = snapshot();
    value.localIdentifiers.sessionIds = Array.from(
      { length: 129 },
      (_, index) => `session-${index}`,
    );
    const parsed = accountErasureRemoteSnapshotSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected budget failure");
    expect(parsed.error.issues[0]?.path).toEqual(["localIdentifiers", "sessionIds"]);
  });

  it("reports a single oversized local item under its localIdentifiers list path", () => {
    const value = snapshot();
    value.localIdentifiers.fileUploads = [fileUpload(4097)];
    const parsed = accountErasureRemoteSnapshotSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected budget failure");
    expect(parsed.error.issues[0]?.path).toEqual(["localIdentifiers", "fileUploads"]);
  });

  it("reports the combined local-list envelope on the localIdentifiers path", () => {
    const value = snapshot();
    value.localIdentifiers.fileUploads = [
      ...Array.from({ length: 15 }, () => fileUpload(4096)),
      fileUpload(4076),
    ];
    const parsed = accountErasureRemoteSnapshotSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected budget failure");
    expect(parsed.error.issues[0]?.path).toEqual(["localIdentifiers"]);
  });

  it("counts only revocation_credentials provider tokens toward the credential budget", () => {
    const value = snapshot();
    value.providerConnections = Array.from({ length: 8 }, (_, index) =>
      revocationConnection({
        accessToken: "x".repeat(65536),
        providerId: `provider-${index}`,
      }),
    );
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).not.toThrow();
    value.providerConnections.push(
      revocationConnection({
        accessToken: "x",
        providerId: "provider-overflow",
      }),
    );
    expect(() => accountErasureRemoteSnapshotSchema.parse(value)).toThrow(snapshotBudgetError);

    const ignored = snapshot();
    ignored.providerConnections = Array.from({ length: 128 }, (_, index) => ({
      disposition: "no_remote_authorization" as const,
      providerId: `provider-${index}`,
    }));
    // Array-entry limit is 128; credential budget must stay unused for this disposition.
    expect(() => accountErasureRemoteSnapshotSchema.parse(ignored)).not.toThrow();
  });

  it("decryptAccountErasureSnapshot rejects oversized plaintext and maps budget Zod failures", async () => {
    const userId = randomUUID();
    const valid = snapshot();
    decryptCredentialValue.mockReset();
    decryptCredentialValue.mockResolvedValueOnce(JSON.stringify(valid));
    await expect(decryptAccountErasureSnapshot("encrypted-fixture", userId)).resolves.toEqual(
      valid,
    );
    expect(decryptCredentialValue).toHaveBeenCalledWith("encrypted-fixture", {
      tableName: "fitness.account_erasure_request",
      columnName: "encrypted_remote_snapshot",
      scopeId: userId,
    });

    // Exact encoded-size limit must still decrypt; one more byte is a budget error.
    const atLimit = snapshot();
    atLimit.stripe = { customerId: "", subscriptionId: null };
    const overhead = Buffer.byteLength(JSON.stringify(atLimit), "utf8");
    atLimit.stripe.customerId = "x".repeat(1048576 - overhead);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(1048576);
    decryptCredentialValue.mockResolvedValueOnce(JSON.stringify(atLimit));
    await expect(decryptAccountErasureSnapshot("encrypted-fixture", userId)).resolves.toEqual(
      atLimit,
    );

    decryptCredentialValue.mockResolvedValueOnce(`${"x".repeat(1048577)}`);
    await expect(decryptAccountErasureSnapshot("encrypted-fixture", userId)).rejects.toBeInstanceOf(
      AccountErasureSnapshotBudgetError,
    );

    const overBudget = snapshot();
    overBudget.authIdentities = Array.from({ length: 129 }, (_, index) => ({
      authProvider: "fixture",
      providerAccountId: `account-${index}`,
      email: null,
    }));
    decryptCredentialValue.mockResolvedValueOnce(JSON.stringify(overBudget));
    await expect(decryptAccountErasureSnapshot("encrypted-fixture", userId)).rejects.toBeInstanceOf(
      AccountErasureSnapshotBudgetError,
    );
  });

  it("decryptAccountErasureSnapshot preserves non-budget schema failures", async () => {
    decryptCredentialValue.mockReset();
    decryptCredentialValue.mockResolvedValueOnce(JSON.stringify({ not: "a-snapshot" }));
    await expect(
      decryptAccountErasureSnapshot("encrypted-fixture", randomUUID()),
    ).rejects.not.toBeInstanceOf(AccountErasureSnapshotBudgetError);
  });

  it("decryptAccountErasureSnapshot rejects ciphertext above the encrypted-size budget", async () => {
    decryptCredentialValue.mockReset();
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(decryptAccountErasureSnapshot(oversized, randomUUID())).rejects.toBeInstanceOf(
      AccountErasureSnapshotBudgetError,
    );
    expect(decryptCredentialValue).not.toHaveBeenCalled();
  });
});
