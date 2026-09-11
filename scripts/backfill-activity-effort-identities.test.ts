import { describe, expect, it, vi } from "vitest";
import {
  backfillActivityEffortIdentities,
  extractActivityEffortIdentities,
} from "../src/db/activity-effort-identity-backfill.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const options = {
  end: new Date("2026-09-02T00:00:00.000Z"),
  execute: true,
  start: new Date("2026-09-01T00:00:00.000Z"),
  userId,
};

describe("extractActivityEffortIdentities", () => {
  it("extracts stable IDs but not provider activity instance IDs", () => {
    expect(
      extractActivityEffortIdentities({
        externalId: "instance-1",
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
        externalId: "activity-instance",
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

describe("backfillActivityEffortIdentities", () => {
  it("rejects an invalid audit window before reading provider payloads", async () => {
    const db = { execute: vi.fn() };

    await expect(
      backfillActivityEffortIdentities(db, {
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
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { id: "instance-1", pelotonClassId: "class-1" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toEqual({
      conflicts: 0,
      details: [],
      detailsTruncated: false,
      inserted: 0,
      refreshReady: true,
      scanned: 1,
      skipped: 0,
      updated: 0,
    });
    await expect(backfillActivityEffortIdentities(db, options)).resolves.toEqual({
      conflicts: 0,
      details: [],
      detailsTruncated: false,
      inserted: 0,
      refreshReady: true,
      scanned: 1,
      skipped: 0,
      updated: 0,
    });
  });

  it("reports differing exact raw identities from one canonical group as a conflict", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1" },
        },
        {
          external_id: "instance-2",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000102",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-2" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toEqual({
      conflicts: 1,
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          canonicalGroupId: "00000000-0000-4000-8000-000000000901",
          kind: "conflict",
          providerId: "peloton",
          sourceExternalId: "instance-1",
          sourceField: "pelotonClassId",
          values: ["class-1", "class-2"],
        },
        {
          activityId: "00000000-0000-4000-8000-000000000102",
          canonicalGroupId: "00000000-0000-4000-8000-000000000901",
          kind: "conflict",
          providerId: "peloton",
          sourceExternalId: "instance-2",
          sourceField: "pelotonClassId",
          values: ["class-1", "class-2"],
        },
      ],
      detailsTruncated: false,
      inserted: 0,
      refreshReady: true,
      scanned: 2,
      skipped: 0,
      updated: 0,
    });
  });

  it("uses the dbt normalized identity value when counting conflicts", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "Class  1" },
        },
        {
          external_id: "instance-2",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000102",
          provider_id: "peloton",
          raw: { pelotonClassId: " class 1 " },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      conflicts: 0,
    });
  });

  it("keeps distinct mapped fields on one source as separate evidence, not a conflict", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1", templateId: "template-1" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      conflicts: 0,
    });
  });

  it("marks a null raw payload as skipped with its source identity", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: null,
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          kind: "unsupported",
          providerId: "peloton",
          sourceExternalId: "instance-1",
          sourceField: "raw",
          values: [null],
        },
      ],
      skipped: 1,
    });
  });

  it("reports unsupported raw fields and values for a skipped source", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "trainerroad",
          raw: { customWorkoutCode: "unsupported" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          kind: "unsupported",
          providerId: "trainerroad",
          sourceExternalId: "instance-1",
          sourceField: "customWorkoutCode",
          values: ["unsupported"],
        },
      ],
      skipped: 1,
    });
  });

  it("marks a zero canonical group as not ready for the dbt refresh", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-0000-0000-000000000000",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      details: [
        {
          activityId: "00000000-0000-4000-8000-000000000101",
          kind: "invalid_group_id",
          providerId: "peloton",
          sourceField: "group_id",
          values: ["00000000-0000-0000-0000-000000000000"],
        },
      ],
      refreshReady: false,
    });
  });

  it("reports each conflicting source claim with the competing values", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        {
          external_id: "instance-1",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000101",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-1" },
        },
        {
          external_id: "instance-2",
          group_id: "00000000-0000-4000-8000-000000000901",
          id: "00000000-0000-4000-8000-000000000102",
          provider_id: "peloton",
          raw: { pelotonClassId: "class-2" },
        },
      ]),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      conflicts: 1,
      details: expect.arrayContaining([
        expect.objectContaining({
          activityId: "00000000-0000-4000-8000-000000000101",
          kind: "conflict",
          providerId: "peloton",
          sourceExternalId: "instance-1",
          sourceField: "pelotonClassId",
          values: ["class-1", "class-2"],
        }),
        expect.objectContaining({
          activityId: "00000000-0000-4000-8000-000000000102",
          kind: "conflict",
          providerId: "peloton",
          sourceExternalId: "instance-2",
          sourceField: "pelotonClassId",
          values: ["class-1", "class-2"],
        }),
      ]),
    });
  });

  it("truncates diagnostic output at the audit detail cap", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue(
        Array.from({ length: 101 }, (_, index) => ({
          external_id: `instance-${index}`,
          group_id: "00000000-0000-4000-8000-000000000901",
          id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
          provider_id: "peloton",
          raw: null,
        })),
      ),
    };

    await expect(backfillActivityEffortIdentities(db, options)).resolves.toMatchObject({
      detailsTruncated: true,
      skipped: 101,
    });
    const result = await backfillActivityEffortIdentities(db, options);
    expect(result.details).toHaveLength(100);
  });
});

describe("parseActivityEffortIdentityBackfillOptions", () => {
  it("requires a user-scoped UTC window and defaults to an audit", async () => {
    const { parseActivityEffortIdentityBackfillOptions } = await import(
      "./backfill-activity-effort-identities.ts"
    );

    expect(
      parseActivityEffortIdentityBackfillOptions([
        "--user-id",
        userId,
        "--start",
        "2026-09-01T00:00:00.000Z",
        "--end",
        "2026-09-02T00:00:00.000Z",
      ]),
    ).toEqual({ ...options, execute: false });
  });
});
