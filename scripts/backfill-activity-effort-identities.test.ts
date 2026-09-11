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
      inserted: 0,
      scanned: 1,
      skipped: 0,
      updated: 0,
    });
    await expect(backfillActivityEffortIdentities(db, options)).resolves.toEqual({
      conflicts: 0,
      inserted: 0,
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
      inserted: 0,
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
