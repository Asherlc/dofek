import { describe, expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../repositories/climbing-test-helpers.ts";
import {
  climbingLogEntryDetailResponseSchema,
  decodeClimbingLogEntriesResponse,
  decodeClimbingLogEntryDetailResponse,
  legacyClimbingLogEntryDetailSchema,
  serializeClimbingLogEntryDetailResponse,
} from "./climbing-log-contracts.ts";

describe("versioned climbing detail responses", () => {
  it("retains attributed recorded tags in V3 without changing stored log traits", () => {
    const tags = [
      {
        providerId: "kaya",
        sourceKey: "custom",
        label: "Funky",
        categoryKey: "81",
        categoryLabel: null,
      },
    ];
    const entry = { ...climbingLogEntryFixture(), tags };
    const response = serializeClimbingLogEntryDetailResponse(entry, 3);
    expect(response).toEqual(entry);
    expect(decodeClimbingLogEntryDetailResponse(response)).toEqual(entry);
    expect(decodeClimbingLogEntriesResponse([response])).toEqual([entry]);
  });
  it.each([1, 2] as const)("omits attributed tags from the strict V%s contract", (version) => {
    const entry = {
      ...climbingLogEntryFixture(),
      tags: [
        {
          providerId: "kaya",
          sourceKey: "937",
          label: "Crimp",
          categoryKey: "3",
          categoryLabel: "Grip",
        },
      ],
    };
    const response = serializeClimbingLogEntryDetailResponse(entry, version);
    const { tags: _tags, ...withoutTags } = entry;
    expect(decodeClimbingLogEntryDetailResponse(response)).toEqual(withoutTags);
  });
  it("decodes an old-server scalar response into canonical traits for an updated client", () => {
    const { holdTypes: _holds, ...entry } = climbingLogEntryFixture({
      wallAngle: { value: -10, unit: "degrees" },
    });
    const legacy = { ...entry, holdType: "crimp" };
    expect(decodeClimbingLogEntryDetailResponse(legacy)).toEqual({
      ...entry,
      holdTypes: ["crimp"],
    });
    expect(decodeClimbingLogEntriesResponse([legacy])).toEqual([
      { ...entry, holdTypes: ["crimp"] },
    ]);
  });

  it("preserves all canonical V2 traits for updated clients", () => {
    const entry = climbingLogEntryFixture({
      wallAngle: { category: "roof" },
      holdTypes: ["jug", "jam"],
    });
    expect(serializeClimbingLogEntryDetailResponse(entry, 2)).toEqual(entry);
    expect(decodeClimbingLogEntryDetailResponse(entry)).toEqual(entry);
  });

  it("serves a strict original contract to callers without V2 support", () => {
    const entry = climbingLogEntryFixture({
      wallAngle: { category: "roof" },
      holdTypes: ["jug", "jam"],
    });
    const legacy = serializeClimbingLogEntryDetailResponse(entry, 1);
    expect(legacyClimbingLogEntryDetailSchema.parse(legacy)).toMatchObject({
      holdType: null,
      wallAngle: null,
    });
    expect(climbingLogEntryDetailResponseSchema.parse(legacy)).toEqual(legacy);
    expect(decodeClimbingLogEntryDetailResponse(legacy)).toMatchObject({
      holdTypes: null,
      wallAngle: null,
    });
  });

  it.each([
    { holdTypes: ["crimp"] },
    {
      tags: [
        {
          providerId: "kaya",
          sourceKey: "937",
          label: "Crimp",
          categoryKey: "3",
          categoryLabel: "Grip",
        },
      ],
    },
  ])("rejects newer trait fields in the strict original contract: %j", async (newerFields) => {
    vi.resetModules();
    const { legacyClimbingLogEntryDetailSchema: legacySchema } = await import(
      "./climbing-log-contracts.ts"
    );
    const legacy = serializeClimbingLogEntryDetailResponse(climbingLogEntryFixture(), 1);
    expect(legacySchema.parse(legacy)).toEqual(legacy);
    expect(legacySchema.safeParse({ ...legacy, ...newerFields }).success).toBe(false);
  });

  it.each([1, 2] as const)("preserves the owned graph through a V%s response", (version) => {
    const logId = "20000000-0000-4000-8000-000000000001";
    const climb = climbingClimbFixture();
    const pitch = {
      id: "20000000-0000-4000-8000-000000000006",
      climbId: climb.id,
      externalId: "source-pitch",
      number: 1,
      name: "First pitch",
      publishedGrades: [{ value: "5.10a", system: "yds" as const }],
    };
    climb.pitches = [pitch];
    const attempt = climbingAttemptFixture(logId, {
      scope: "pitch",
      pitchId: pitch.id,
      outcome: "completed",
      ropeMethod: "lead",
      rockResultLabels: ["sent", "Flash"],
    });
    const entry = climbingLogEntryFixture({
      id: logId,
      climbId: climb.id,
      climb,
      mapLocation: {
        coordinates: { latitude: 37.8, longitude: -122.2 },
        scope: "climb",
        objectId: climb.id,
        providerId: "openbeta",
        name: "Corner",
      },
      reportedGrades: [{ value: "5.10b", system: "yds" }],
      holdTypes: ["jug", "jam"],
      wallAngle: { category: "roof" },
      raw: { source: "retained catalogue metadata" },
      attempts: [attempt],
      recordedClimbAttemptCount: 0,
      recordedPitchAttemptCount: 1,
      pitchResults: [
        {
          pitch,
          attemptIds: [attempt.id],
          recordedAttemptCount: 1,
          recordedOutcome: "completed",
          displayGrade: "5.10a",
        },
      ],
      sourceLinks: [{ providerId: "openbeta", kind: "route", url: "https://openbeta.io/climb/1" }],
    });
    const expected = version === 2 ? entry : { ...entry, holdTypes: null, wallAngle: null };
    const response = serializeClimbingLogEntryDetailResponse(entry, version);

    expect(decodeClimbingLogEntryDetailResponse(response)).toEqual(expected);
    expect(decodeClimbingLogEntriesResponse([response])).toEqual([expected]);
  });

  it("rejects malformed and mixed contracts instead of treating any invalid response as V1", () => {
    const entry = climbingLogEntryFixture();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, holdType: "crimp" })).toThrow();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, holdTypes: "crimp" })).toThrow();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, attempts: "invalid" })).toThrow();
  });
});
