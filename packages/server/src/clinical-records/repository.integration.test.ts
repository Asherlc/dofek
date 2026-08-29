import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensurePushProvider } from "../repositories/push-provider-repository.ts";
import type { ClinicalRecordInput } from "./fhir.ts";
import { ClinicalRecordsRepository } from "./repository.ts";

const USER_A = "44444444-4444-4444-8444-444444444444";
const USER_B = "55555555-5555-4555-8555-555555555555";
const USER_C = "88888888-8888-4888-8888-888888888888";

function condition(overrides: Partial<ClinicalRecordInput> = {}): ClinicalRecordInput {
  return {
    externalId: "11111111-1111-4111-8111-111111111111",
    clinicalType: "condition",
    displayName: "Seasonal asthma",
    sourceName: "Example Health",
    fhirVersion: "R4",
    fhir: {
      resourceType: "Condition",
      recordedDate: "2026-05-06T15:00:00Z",
    },
    downloadedAt: "2026-05-08T17:00:00.000Z",
    ...overrides,
  };
}

describe("ClinicalRecordsRepository (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES
        (${USER_A}, 'Clinical User A'),
        (${USER_B}, 'Clinical User B'),
        (${USER_C}, 'Clinical User C')
      ON CONFLICT (id) DO NOTHING
    `);
    await ensurePushProvider({ database: context.db, providerId: "apple_health", userId: USER_A });
    await ensurePushProvider({ database: context.db, providerId: "apple_health", userId: USER_B });
    await ensurePushProvider({ database: context.db, providerId: "apple_health", userId: USER_C });
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("isolates list and detail reads by the authenticated user", async () => {
    const userARepository = new ClinicalRecordsRepository(context.db, USER_A, "UTC");
    const userBRepository = new ClinicalRecordsRepository(context.db, USER_B, "UTC");
    const pushed = await userBRepository.upsert([condition()]);

    expect(await userARepository.list({ limit: 20, offset: 0 })).toEqual({
      records: [],
      nextOffset: null,
    });
    expect(await userARepository.detail(pushed.ids[0] ?? "")).toBeNull();
    expect((await userBRepository.list({ limit: 20, offset: 0 })).records).toHaveLength(1);
  });

  it("updates an existing HealthKit UUID instead of creating a duplicate source of truth", async () => {
    const repository = new ClinicalRecordsRepository(context.db, USER_A, "UTC");
    await repository.upsert([condition()]);
    const result = await repository.upsert([
      condition({
        displayName: "Updated asthma record",
        fhir: {
          resourceType: "Condition",
          recordedDate: "2026-05-07T15:00:00Z",
          verificationStatus: { text: "confirmed" },
        },
      }),
    ]);

    const rows = await context.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM fitness.clinical_record
      WHERE user_id = ${USER_A}
        AND provider_id = 'apple_health'
        AND external_id = '11111111-1111-4111-8111-111111111111'
    `);
    const detail = await repository.detail(result.ids[0] ?? "");

    expect(rows).toEqual([{ count: "1" }]);
    expect(detail).toMatchObject({
      displayName: "Updated asthma record",
      recordedAt: "2026-05-07T15:00:00.000Z",
      fhir: {
        resourceType: "Condition",
        verificationStatus: { text: "confirmed" },
      },
    });
  });

  it("updates every conflicting record in a multi-record HealthKit batch", async () => {
    const repository = new ClinicalRecordsRepository(context.db, USER_A, "UTC");
    const firstExternalId = "66666666-6666-4666-8666-666666666666";
    const secondExternalId = "77777777-7777-4777-8777-777777777777";
    await repository.upsert([
      condition({ externalId: firstExternalId, displayName: "First old name" }),
      condition({ externalId: secondExternalId, displayName: "Second old name" }),
    ]);

    const result = await repository.upsert([
      condition({ externalId: firstExternalId, displayName: "First new name" }),
      condition({ externalId: secondExternalId, displayName: "Second new name" }),
    ]);
    const details = await Promise.all(result.ids.map((id) => repository.detail(id)));

    expect(details.map((detail) => detail?.displayName).sort()).toEqual([
      "First new name",
      "Second new name",
    ]);
  });

  it("paginates newest downloads without skipping or duplicating records", async () => {
    const repository = new ClinicalRecordsRepository(context.db, USER_C, "UTC");
    await repository.upsert([
      condition(),
      condition({
        externalId: "22222222-2222-4222-8222-222222222222",
        downloadedAt: "2026-05-09T17:00:00.000Z",
      }),
      condition({
        externalId: "33333333-3333-4333-8333-333333333333",
        downloadedAt: "2026-05-10T17:00:00.000Z",
      }),
    ]);

    const firstPage = await repository.list({ limit: 2, offset: 0 });
    const secondPage = await repository.list({ limit: 2, offset: firstPage.nextOffset ?? 0 });

    expect(firstPage.records).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    expect(secondPage.records.length).toBeGreaterThan(0);
    expect(secondPage.nextOffset).toBeNull();
    expect(new Set([...firstPage.records, ...secondPage.records].map((row) => row.id)).size).toBe(
      firstPage.records.length + secondPage.records.length,
    );
  });
});
