import { describe, expect, it, vi } from "vitest";
import {
  auditActivityEffortIdentities,
  extractActivityEffortIdentities,
} from "./activity-effort-identity-backfill.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const options = {
  end: new Date("2026-09-02T00:00:00.000Z"),
  start: new Date("2026-09-01T00:00:00.000Z"),
  userId,
};

describe("extractActivityEffortIdentities", () => {
  it("extracts stable IDs but not provider activity instance IDs", () => {
    expect(
      extractActivityEffortIdentities({
        providerId: "peloton",
        raw: { id: "instance-1", pelotonClassId: "class-1" },
      }),
    ).toEqual([
      {
        kind: "provider_workout",
        mappingVersion: "v1",
        namespace: "peloton",
        sourceField: "pelotonClassId",
        value: "class-1",
      },
    ]);
  });

  it("matches the dbt v1 field map and ignores unknown raw data", () => {
    expect(
      extractActivityEffortIdentities({
        providerId: "trainerroad",
        raw: {
          courseId: " course-1 ",
          customWorkoutCode: "unsupported",
          segmentId: "segment-1",
          standardizedTestId: "test-1",
          templateId: "template-1",
        },
      }),
    ).toEqual([
      {
        kind: "provider_workout",
        mappingVersion: "v1",
        namespace: "trainerroad",
        sourceField: "templateId",
        value: "template-1",
      },
      {
        kind: "provider_route",
        mappingVersion: "v1",
        namespace: "trainerroad",
        sourceField: "courseId",
        value: "course-1",
      },
      {
        kind: "segment",
        mappingVersion: "v1",
        namespace: "trainerroad",
        sourceField: "segmentId",
        value: "segment-1",
      },
      {
        kind: "standardized_test",
        mappingVersion: "v1",
        namespace: "trainerroad",
        sourceField: "standardizedTestId",
        value: "test-1",
      },
    ]);
  });
});

describe("auditActivityEffortIdentities", () => {
  it("rejects an invalid audit window before reading provider payloads", async () => {
    const db = { execute: vi.fn() };

    await expect(
      auditActivityEffortIdentities(db, {
        ...options,
        start: new Date("2026-09-02T00:00:00.000Z"),
      }),
    ).rejects.toThrow("start must be before end");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("is stable when the raw-payload audit is rerun", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { id: "instance-1", pelotonClassId: "class-1" },
        },
      ]),
    };

    const expected = {
      conflicts: 0,
      details: [],
      detailsTruncated: false,
      refreshReady: true,
      scanned: 1,
      skipped: 0,
    };
    await expect(auditActivityEffortIdentities(db, options)).resolves.toEqual(expected);
    await expect(auditActivityEffortIdentities(db, options)).resolves.toEqual(expected);
  });

  it("reports differing exact raw identities without exposing their values", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "private-class-1" },
        },
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000102",
          provider_id: "peloton",
          raw: { pelotonClassId: "private-class-2" },
        },
      ]),
    };

    const result = await auditActivityEffortIdentities(db, options);

    expect(result).toEqual({
      conflicts: 1,
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          canonicalGroupId: "00000000-0000-4000-8000-000000000901",
          distinctValueCount: 2,
          kind: "conflict",
          providerId: "peloton",
          sourceField: "pelotonClassId",
          valueTypes: ["string"],
        },
        {
          activityId: "00000000-0000-4000-8000-000000000102",
          canonicalGroupId: "00000000-0000-4000-8000-000000000901",
          distinctValueCount: 2,
          kind: "conflict",
          providerId: "peloton",
          sourceField: "pelotonClassId",
          valueTypes: ["string"],
        },
      ],
      detailsTruncated: false,
      refreshReady: true,
      scanned: 2,
      skipped: 0,
    });
    expect(JSON.stringify(result)).not.toContain("private-class");
  });

  it("uses the dbt normalized identity value when counting conflicts", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "Class  1" },
        },
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000102",
          provider_id: "peloton",
          raw: { pelotonClassId: " class 1 " },
        },
      ]),
    };

    await expect(auditActivityEffortIdentities(db, options)).resolves.toMatchObject({
      conflicts: 0,
    });
  });

  it("keeps distinct mapped fields on one source as separate evidence", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1", templateId: "template-1" },
        },
      ]),
    };

    await expect(auditActivityEffortIdentities(db, options)).resolves.toMatchObject({
      conflicts: 0,
    });
  });

  it("summarizes a null raw payload as skipped", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: null,
        },
      ]),
    };

    await expect(auditActivityEffortIdentities(db, options)).resolves.toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          distinctValueCount: 1,
          kind: "unsupported",
          providerId: "peloton",
          sourceField: "raw",
          valueTypes: ["null"],
        },
      ],
      skipped: 1,
    });
  });

  it("summarizes unsupported raw fields without exposing their values", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "trainerroad",
          raw: { customWorkoutCode: "private-unsupported-value" },
        },
      ]),
    };

    const result = await auditActivityEffortIdentities(db, options);

    expect(result).toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          distinctValueCount: 1,
          kind: "unsupported",
          providerId: "trainerroad",
          sourceField: "customWorkoutCode",
          valueTypes: ["string"],
        },
      ],
      skipped: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private-unsupported-value");
  });

  it("marks a zero canonical group as not ready for the dbt refresh", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          group_id: "00000000-0000-0000-0000-000000000000",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1" },
        },
      ]),
    };

    await expect(auditActivityEffortIdentities(db, options)).resolves.toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          distinctValueCount: 1,
          kind: "invalid_group_id",
          providerId: "peloton",
          sourceField: "group_id",
          valueTypes: ["string"],
        },
      ],
      refreshReady: false,
    });
  });

  it("truncates diagnostic output at the audit detail cap", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue(
        Array.from({ length: 101 }, (_, index) => ({
          group_id: "00000000-0000-4000-8000-000000000901",
          id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
          provider_id: "peloton",
          raw: null,
        })),
      ),
    };

    const result = await auditActivityEffortIdentities(db, options);

    expect(result).toMatchObject({ detailsTruncated: true, skipped: 101 });
    expect(result.details).toHaveLength(100);
  });
});
