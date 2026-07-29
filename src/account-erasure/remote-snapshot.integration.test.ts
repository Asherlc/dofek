import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import type { Provider } from "../providers/types.ts";
import { isEncryptedCredentialValue } from "../security/credential-encryption.ts";
import {
  createEncryptedAccountErasureSnapshot,
  decryptAccountErasureSnapshot,
} from "./remote-snapshot.ts";

const userId = "10000000-0000-4000-8000-000000001995";
const legacyUserId = "20000000-0000-4000-8000-000000001995";
const mapMyFitnessUserId = "30000000-0000-4000-8000-000000001995";
const legacyMapMyFitnessUserId = "40000000-0000-4000-8000-000000001995";
const legacyKomootUserId = "50000000-0000-4000-8000-000000001995";
const corosUserId = "60000000-0000-4000-8000-000000001995";
const decathlonUserId = "70000000-0000-4000-8000-000000001995";
const missingAuthTokenUserId = "80000000-0000-4000-8000-000000001995";
const localOnlyUserId = "90000000-0000-4000-8000-000000001995";
const legacyWithingsUserId = "a0000000-0000-4000-8000-000000001995";
const withingsUserId = "b0000000-0000-4000-8000-000000001995";
const storedAccountRowSchema = z.object({
  provider_account_id: z.string().min(1),
});
const authProviderDefinitions = [
  ["polar", "Polar"],
  ["mapmyfitness", "MapMyFitness"],
  ["komoot", "Komoot"],
  ["coros", "COROS"],
  ["decathlon", "Decathlon"],
  ["wahoo", "Wahoo"],
  ["withings", "Withings"],
] as const;
const providers: Provider[] = [
  ...authProviderDefinitions.map(
    ([providerId, providerName]): Provider => ({
      authSetup: () => ({}),
      id: providerId,
      name: providerName,
      sync: async () => ({
        duration: 0,
        errors: [],
        provider: providerId,
        recordsSynced: 0,
      }),
      validate: () => null,
    }),
  ),
  {
    id: "strong-csv",
    importOnly: true,
    name: "Strong CSV",
    validate: () => null,
  },
];

describe("account-erasure remote snapshot persistence (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${userId}::uuid, 'Polar Snapshot User'),
            (${legacyUserId}::uuid, 'Legacy Polar Snapshot User'),
            (${mapMyFitnessUserId}::uuid, 'MapMyFitness Snapshot User'),
            (${legacyMapMyFitnessUserId}::uuid, 'Legacy MapMyFitness Snapshot User'),
            (${legacyKomootUserId}::uuid, 'Legacy Komoot Snapshot User'),
            (${corosUserId}::uuid, 'COROS Snapshot User'),
            (${decathlonUserId}::uuid, 'Decathlon Snapshot User'),
            (${missingAuthTokenUserId}::uuid, 'Missing Auth Token Snapshot User'),
            (${localOnlyUserId}::uuid, 'Local-only Snapshot User'),
            (${legacyWithingsUserId}::uuid, 'Legacy Withings Snapshot User'),
            (${withingsUserId}::uuid, 'Withings Snapshot User')`,
    );
    await ensureProvider(
      context.db,
      "polar",
      "Polar",
      "https://www.polaraccesslink.com/v3",
      userId,
    );
    await ensureProvider(
      context.db,
      "wahoo",
      "Wahoo",
      "https://api.wahooligan.com",
      missingAuthTokenUserId,
    );
    await ensureProvider(context.db, "strong-csv", "Strong CSV", undefined, localOnlyUserId);
    await ensureProvider(
      context.db,
      "withings",
      "Withings",
      "https://wbsapi.withings.net",
      legacyWithingsUserId,
    );
    await ensureProvider(
      context.db,
      "withings",
      "Withings",
      "https://wbsapi.withings.net",
      withingsUserId,
    );
    await ensureProvider(
      context.db,
      "polar",
      "Polar",
      "https://www.polaraccesslink.com/v3",
      legacyUserId,
    );
    await ensureProvider(
      context.db,
      "mapmyfitness",
      "MapMyFitness",
      "https://api.mapmyfitness.com",
      mapMyFitnessUserId,
    );
    await ensureProvider(
      context.db,
      "mapmyfitness",
      "MapMyFitness",
      "https://api.mapmyfitness.com",
      legacyMapMyFitnessUserId,
    );
    await ensureProvider(
      context.db,
      "komoot",
      "Komoot",
      "https://external-api.komoot.de/v007",
      legacyKomootUserId,
    );
    await ensureProvider(context.db, "coros", "COROS", "https://open.coros.com", corosUserId);
    await ensureProvider(
      context.db,
      "decathlon",
      "Decathlon",
      "https://api.decathlon.net",
      decathlonUserId,
    );
    await saveTokens(
      context.db,
      "polar",
      {
        accessToken: "polar-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        providerAccountId: "99887766",
        refreshToken: null,
        scopes: "accesslink.read_all",
      },
      userId,
    );
    await saveTokens(
      context.db,
      "polar",
      {
        accessToken: "legacy-polar-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: null,
        scopes: "accesslink.read_all",
      },
      legacyUserId,
    );
    await saveTokens(
      context.db,
      "mapmyfitness",
      {
        accessToken: "mapmyfitness-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        providerAccountId: "123456",
        refreshToken: "mapmyfitness-refresh-token",
        scopes: "read",
      },
      mapMyFitnessUserId,
    );
    await saveTokens(
      context.db,
      "mapmyfitness",
      {
        accessToken: "legacy-mapmyfitness-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: "legacy-mapmyfitness-refresh-token",
        scopes: "read",
      },
      legacyMapMyFitnessUserId,
    );
    await saveTokens(
      context.db,
      "komoot",
      {
        accessToken: "legacy-komoot-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: null,
        scopes: "profile",
      },
      legacyKomootUserId,
    );
    await saveTokens(
      context.db,
      "coros",
      {
        accessToken: "coros-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: "coros-refresh-token",
        scopes: null,
      },
      corosUserId,
    );
    await saveTokens(
      context.db,
      "decathlon",
      {
        accessToken: "decathlon-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: "decathlon-refresh-token",
        scopes: "openid profile",
      },
      decathlonUserId,
    );
    await saveTokens(
      context.db,
      "withings",
      {
        accessToken: "legacy-withings-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: "legacy-withings-refresh-token",
        scopes: "user.metrics",
      },
      legacyWithingsUserId,
    );
    await saveTokens(
      context.db,
      "withings",
      {
        accessToken: "withings-access-token",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        providerAccountId: "489418",
        refreshToken: "withings-refresh-token",
        scopes: "user.metrics",
      },
      withingsUserId,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("encrypts the durable Polar account id and includes it in the encrypted snapshot", async () => {
    const [storedAccount] = await executeWithSchema(
      context.db,
      storedAccountRowSchema,
      sql`SELECT provider_account_id
          FROM fitness.oauth_token
          WHERE user_id = ${userId}::uuid
            AND provider_id = 'polar'`,
    );
    expect(storedAccount).toBeDefined();
    if (!storedAccount) throw new Error("Expected persisted Polar account id");
    expect(storedAccount.provider_account_id).not.toBe("99887766");
    expect(isEncryptedCredentialValue(storedAccount.provider_account_id)).toBe(true);

    await saveTokens(
      context.db,
      "polar",
      {
        accessToken: "refreshed-polar-access-token",
        expiresAt: new Date("2099-06-01T00:00:00.000Z"),
        refreshToken: null,
        scopes: "accesslink.read_all",
      },
      userId,
    );
    await expect(loadTokens(context.db, "polar", userId)).resolves.toEqual(
      expect.objectContaining({ providerAccountId: "99887766" }),
    );

    const encryptedSnapshot = await context.db.transaction((transaction) =>
      createEncryptedAccountErasureSnapshot(transaction, userId, providers),
    );
    expect(encryptedSnapshot).not.toContain("99887766");
    await expect(decryptAccountErasureSnapshot(encryptedSnapshot, userId)).resolves.toEqual(
      expect.objectContaining({
        providerConnections: [
          expect.objectContaining({
            disposition: "revocation_credentials",
            providerAccountId: "99887766",
            providerId: "polar",
          }),
        ],
      }),
    );
  });

  it("fails before activation when a legacy Polar connection lacks a durable account id", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, legacyUserId, providers),
      ),
    ).rejects.toThrow(
      "Reconnect Polar before deleting your account so Dofek can durably revoke the Polar authorization.",
    );
  });

  it("includes the durable MapMyFitness user id in the encrypted snapshot", async () => {
    const encryptedSnapshot = await context.db.transaction((transaction) =>
      createEncryptedAccountErasureSnapshot(transaction, mapMyFitnessUserId, providers),
    );
    expect(encryptedSnapshot).not.toContain("123456");
    await expect(
      decryptAccountErasureSnapshot(encryptedSnapshot, mapMyFitnessUserId),
    ).resolves.toEqual(
      expect.objectContaining({
        providerConnections: [
          expect.objectContaining({
            disposition: "revocation_credentials",
            providerAccountId: "123456",
            providerId: "mapmyfitness",
          }),
        ],
      }),
    );
  });

  it("requires legacy MapMyFitness and Komoot connections to reconnect", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, legacyMapMyFitnessUserId, providers),
      ),
    ).rejects.toThrow(
      "Reconnect MapMyFitness before deleting your account so Dofek can durably revoke the MapMyFitness authorization.",
    );
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, legacyKomootUserId, providers),
      ),
    ).rejects.toThrow(
      "Reconnect Komoot before deleting your account so Dofek can durably revoke the Komoot authorization.",
    );
  });

  it("requires legacy Withings connections to reconnect for a durable account id", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, legacyWithingsUserId, providers),
      ),
    ).rejects.toThrow(
      "Reconnect Withings before deleting your account so Dofek can identify the remote authorization that must be revoked.",
    );
  });

  it("blocks Withings deletion until its signed remote-revocation contract is available", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, withingsUserId, providers),
      ),
    ).rejects.toThrow(
      "Revoke Dofek's access in Withings, then disconnect Withings in Dofek before deleting your account.",
    );
  });

  it("requires unsupported active providers to be manually unlinked first", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, corosUserId, providers),
      ),
    ).rejects.toThrow(
      "Disconnect Dofek in the COROS app under Profile > Settings > 3rd Party Apps > Data Sync, then disconnect COROS in Dofek before deleting your account.",
    );
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, decathlonUserId, providers),
      ),
    ).rejects.toThrow(
      "Manually unlink Dofek from your Decathlon account (contact Decathlon support if no unlink control is available), then disconnect Decathlon in Dofek before deleting your account.",
    );
  });

  it("fails confirmation when an auth-capable connection has no revocation credentials", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(transaction, missingAuthTokenUserId, providers),
      ),
    ).rejects.toThrow(
      "Reconnect Wahoo, then disconnect it in Dofek before deleting your account so Dofek can verify the remote authorization is removed.",
    );
  });

  it("snapshots local-only connections with an explicit no-remote disposition", async () => {
    const encryptedSnapshot = await context.db.transaction((transaction) =>
      createEncryptedAccountErasureSnapshot(transaction, localOnlyUserId, providers),
    );

    await expect(
      decryptAccountErasureSnapshot(encryptedSnapshot, localOnlyUserId),
    ).resolves.toEqual(
      expect.objectContaining({
        providerConnections: [
          {
            disposition: "no_remote_authorization",
            providerId: "strong-csv",
          },
        ],
      }),
    );
  });

  it("fails closed when an authoritative connection is absent from the provider registry", async () => {
    await expect(
      context.db.transaction((transaction) =>
        createEncryptedAccountErasureSnapshot(
          transaction,
          localOnlyUserId,
          providers.filter((provider) => provider.id !== "strong-csv"),
        ),
      ),
    ).rejects.toThrow(
      "Dofek cannot verify the strong-csv connection for account deletion. Contact support before retrying.",
    );
  });
});
