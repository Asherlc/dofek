import { describe, expect, it } from "vitest";
import { climbingLogEntryFixture } from "../repositories/climbing-test-helpers.ts";
import {
  climbingLogEntryDetailResponseSchema,
  decodeClimbingLogEntriesResponse,
  decodeClimbingLogEntryDetailResponse,
  legacyClimbingLogEntryDetailSchema,
  serializeClimbingLogEntryDetailResponse,
} from "./climbing-log-contracts.ts";

describe("versioned climbing detail responses", () => {
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

  it("rejects malformed and mixed contracts instead of treating any invalid response as V1", () => {
    const entry = climbingLogEntryFixture();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, holdType: "crimp" })).toThrow();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, holdTypes: "crimp" })).toThrow();
    expect(() => decodeClimbingLogEntryDetailResponse({ ...entry, attempts: "invalid" })).toThrow();
  });
});
