import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockDetail, mockEnsurePushProvider, mockInvalidateAllUserQueries, mockList, mockUpsert } =
  vi.hoisted(() => ({
    mockDetail: vi.fn(),
    mockEnsurePushProvider: vi.fn().mockResolvedValue(undefined),
    mockInvalidateAllUserQueries: vi.fn().mockResolvedValue(undefined),
    mockList: vi.fn(),
    mockUpsert: vi.fn(),
  }));

vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: mockInvalidateAllUserQueries,
}));

vi.mock("../repositories/push-provider-repository.ts", () => ({
  ensurePushProvider: mockEnsurePushProvider,
}));

vi.mock("../clinical-records/repository.ts", () => ({
  ClinicalRecordsRepository: class {
    upsert = mockUpsert;
    list = mockList;
    detail = mockDetail;
  },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { clinicalRecordsRouter } from "./clinical-records.ts";

const createCaller = createTestCallerFactory(clinicalRecordsRouter);
const USER_ID = "99999999-9999-4999-8999-999999999999";

function makeCaller() {
  return createCaller({ db: {}, userId: USER_ID, timezone: "America/Los_Angeles" });
}

function conditionWithObservationFhir() {
  return {
    externalId: "11111111-1111-4111-8111-111111111111",
    clinicalType: "condition" as const,
    displayName: "Asthma",
    sourceName: "Example Health",
    fhirVersion: "R4",
    fhir: { resourceType: "Observation" },
    downloadedAt: "2026-08-28T18:00:00.000Z",
  };
}

describe("clinicalRecordsRouter", () => {
  beforeEach(() => {
    mockDetail.mockReset();
    mockEnsurePushProvider.mockClear();
    mockInvalidateAllUserQueries.mockClear();
    mockList.mockReset();
    mockUpsert.mockReset();
  });

  it("rejects FHIR whose resource type conflicts with its HealthKit type", async () => {
    await expect(
      makeCaller().push({ records: [conditionWithObservationFhir()] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockEnsurePushProvider).not.toHaveBeenCalled();
  });

  it("upserts valid Apple Health records and invalidates the user's cached reads", async () => {
    mockUpsert.mockResolvedValue({
      upserted: 1,
      ids: ["22222222-2222-4222-8222-222222222222"],
    });

    const result = await makeCaller().push({
      records: [
        {
          ...conditionWithObservationFhir(),
          fhir: { resourceType: "Condition", recordedDate: "2026-08-25T12:00:00Z" },
        },
      ],
    });

    expect(result).toEqual({ upserted: 1 });
    expect(mockEnsurePushProvider).toHaveBeenCalledWith({
      database: {},
      providerId: "apple_health",
      providerName: "Apple Health",
      userId: USER_ID,
    });
    expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith(USER_ID);
  });

  it("returns the current user's paginated server-authored summaries", async () => {
    const page = {
      records: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          clinicalType: "condition",
          typeLabel: "Condition",
          displayName: "Asthma",
          sourceName: "Example Health",
          sourceLabel: "Example Health",
          date: "2026-08-25T12:00:00.000Z",
          dateLabel: "Recorded Aug 25, 2026",
          downloadedAt: "2026-08-28T18:00:00.000Z",
          recordedAt: "2026-08-25T12:00:00.000Z",
          issuedAt: null,
        },
      ],
      nextOffset: null,
    };
    mockList.mockResolvedValue(page);

    expect(await makeCaller().list({ limit: 20, offset: 0 })).toEqual(page);
  });

  it("returns NOT_FOUND when a record is absent from the authenticated user's scope", async () => {
    mockDetail.mockResolvedValue(null);

    await expect(
      makeCaller().detail({ id: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Clinical record not found.",
    });
  });
});
