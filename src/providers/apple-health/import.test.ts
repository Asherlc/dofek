import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const { metricStreamReplacementCalls, replaceMetricStreamBatchCalls } = vi.hoisted<{
  metricStreamReplacementCalls: Array<{ scope: unknown; rows: unknown[] }>;
  replaceMetricStreamBatchCalls: Array<{
    scope: unknown;
    metricRows: unknown[];
    sourceType: unknown;
  }>;
}>(() => ({
  metricStreamReplacementCalls: [],
  replaceMetricStreamBatchCalls: [],
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: async (rows: readonly unknown[]) => rows,
    replaceRows: async (_scope: unknown, rows: readonly unknown[]) => {
      metricStreamReplacementCalls.push({ scope: _scope, rows: [...rows] });
      return {
        deleted: {
          version: 1,
          eventType: "metric_stream_deleted",
          scope: _scope,
          partitionKey: "test-partition",
        },
        rows,
      };
    },
  }),
}));

vi.mock("../../db/metric-stream-writer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/metric-stream-writer.ts")>();
  return {
    ...actual,
    replaceMetricStreamBatch: async (
      db: Parameters<typeof actual.replaceMetricStreamBatch>[0],
      scope: Parameters<typeof actual.replaceMetricStreamBatch>[1],
      metricRows: Parameters<typeof actual.replaceMetricStreamBatch>[2],
      sourceType: Parameters<typeof actual.replaceMetricStreamBatch>[3],
      publisher?: Parameters<typeof actual.replaceMetricStreamBatch>[4],
    ) => {
      replaceMetricStreamBatchCalls.push({ scope, metricRows: [...metricRows], sourceType });
      return actual.replaceMetricStreamBatch(db, scope, metricRows, sourceType, publisher);
    },
  };
});

afterEach(() => {
  metricStreamReplacementCalls.length = 0;
  replaceMetricStreamBatchCalls.length = 0;
});

import type { SyncDatabase } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import { makeTransactionalTestDatabase } from "../test-helpers.ts";
import {
  AppleHealthImportValidationError,
  buildSourceNameMap,
  defaultConsoleProgress,
  extractExportXml,
  findLatestExport,
  importAppleHealthFile,
  importClinicalRecords,
  importMedicationDoseEvents,
  readZipEntries,
  runImport,
} from "./import.ts";
import type { ProgressInfo } from "./streaming.ts";

// ============================================================
// FHIR test fixtures
// ============================================================

const labObservation = {
  resourceType: "Observation",
  id: "obs-glucose-001",
  status: "final",
  category: {
    coding: [{ system: "http://hl7.org/fhir/observation-category", code: "laboratory" }],
  },
  code: {
    text: "Glucose",
    coding: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }],
  },
  valueQuantity: { value: 95, unit: "mg/dL" },
  referenceRange: [{ low: { value: 70 }, high: { value: 100 } }],
  effectiveDateTime: "2024-01-15T10:00:00Z",
  issued: "2024-01-16T08:00:00Z",
};

const labObservationWithArrayCategory = {
  resourceType: "Observation",
  id: "obs-bun-001",
  status: "final",
  category: [
    {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "laboratory",
        },
      ],
    },
  ],
  code: {
    text: "BUN",
    coding: [{ system: "http://loinc.org", code: "3094-0" }],
  },
  valueQuantity: { value: 15, unit: "mg/dL" },
  effectiveDateTime: "2024-01-15T10:00:00Z",
};

const labObservationWithLabCode = {
  resourceType: "Observation",
  id: "obs-lab-code-001",
  status: "final",
  category: { coding: [{ code: "LAB" }] },
  code: { text: "WBC" },
  valueQuantity: { value: 7.5, unit: "K/uL" },
  effectiveDateTime: "2024-01-15T10:00:00Z",
};

const vitalObservation = {
  resourceType: "Observation",
  id: "obs-bp-001",
  status: "final",
  category: { coding: [{ code: "vital-signs" }] },
  code: { text: "Blood Pressure" },
  valueQuantity: { value: 120, unit: "mmHg" },
  effectiveDateTime: "2024-01-15T10:00:00Z",
};

const observationWithNoCategory = {
  resourceType: "Observation",
  id: "obs-no-cat-001",
  status: "final",
  code: { text: "Unknown Test" },
  valueQuantity: { value: 42, unit: "units" },
  effectiveDateTime: "2024-01-15T10:00:00Z",
};

const diagnosticReport = {
  resourceType: "DiagnosticReport",
  id: "dr-metabolic-001",
  status: "final",
  code: {
    text: "Metabolic Panel",
    coding: [{ system: "http://loinc.org", code: "24323-8" }],
  },
  effectiveDateTime: "2024-01-15T10:00:00Z",
  result: [{ reference: "Observation/obs-glucose-001" }],
};

const medicationRequest = {
  resourceType: "MedicationRequest",
  id: "med-ceph-001",
  status: "stopped",
  authoredOn: "2024-01-10",
  medicationReference: { display: "Cephalexin 500 mg Cap" },
  contained: [
    {
      resourceType: "Medication",
      code: {
        text: "Cephalexin 500 mg Cap",
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "2231" }],
      },
      form: { text: "Capsule" },
    },
  ],
  dosageInstruction: [{ patientInstruction: "Take 1 capsule 2x daily", route: { text: "Oral" } }],
  requester: { display: "Dr. Smith" },
};

const conditionResource = {
  resourceType: "Condition",
  id: "cond-anxiety-001",
  code: {
    text: "Anxiety",
    coding: [
      { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "F41.9" },
      { system: "http://snomed.info/sct", code: "48694002" },
    ],
  },
  clinicalStatus: { coding: [{ code: "active" }] },
  verificationStatus: { coding: [{ code: "confirmed" }] },
  onsetDateTime: "2023-06-02",
};

const allergyResource = {
  resourceType: "AllergyIntolerance",
  id: "allergy-lactase-001",
  code: {
    text: "LACTASE",
    coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "41397" }],
  },
  type: "allergy",
  clinicalStatus: { coding: [{ code: "active" }] },
  onsetDateTime: "2023-03-27",
  reaction: [{ manifestation: [{ text: "GI distress" }], description: "GI distress" }],
};

// ============================================================
// Mock DB helper
// ============================================================

function createImportMockDb(panelRows: { id: string; externalId: string | null }[] = []) {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  let insertedRowCount = 0;
  const returning = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: insertedRowCount }, () => ({ id: "inserted-clinical-record" })),
      ),
    );
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockImplementation((records: unknown) => {
    insertedRowCount = Array.isArray(records) ? records.length : 1;
    return { onConflictDoUpdate, onConflictDoNothing };
  });
  const insertFn = vi.fn().mockReturnValue({ values });

  // select().from().where() must be directly awaitable (returns Promise)
  const selectWhere = vi.fn().mockResolvedValue(panelRows);
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFn = vi.fn().mockReturnValue({ from: selectFrom });

  const execute = vi.fn().mockResolvedValue([]);

  const db = makeTransactionalTestDatabase<SyncDatabase>({
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  });

  return {
    db,
    spies: {
      deleteFn,
      deleteWhere,
      insertFn,
      values,
      onConflictDoUpdate,
      onConflictDoNothing,
      returning,
      selectFn,
      selectFrom,
      selectWhere,
      execute,
    },
  };
}

// ============================================================
// File creation helpers
// ============================================================

function createClinicalZip(
  baseDir: string,
  name: string,
  clinicalFiles: { name: string; content: string }[],
): string {
  const exportDir = join(baseDir, `${name}-content`, "apple_health_export");
  const clinicalDir = join(exportDir, "clinical-records");
  mkdirSync(clinicalDir, { recursive: true });
  // Always include a placeholder so the export dir is non-empty
  writeFileSync(join(exportDir, "export.xml"), "<HealthData/>", "utf8");
  for (const file of clinicalFiles) {
    writeFileSync(join(clinicalDir, file.name), file.content, "utf8");
  }
  const zipPath = join(baseDir, `${name}.zip`);
  execSync(`cd "${join(baseDir, `${name}-content`)}" && zip -r "${zipPath}" apple_health_export/`);
  return zipPath;
}

function createEmptyZip(baseDir: string, name: string): string {
  const exportDir = join(baseDir, `${name}-content`, "apple_health_export");
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, "export.xml"), "<HealthData/>", "utf8");
  const zipPath = join(baseDir, `${name}.zip`);
  execSync(`cd "${join(baseDir, `${name}-content`)}" && zip -r "${zipPath}" apple_health_export/`);
  return zipPath;
}

function createTestXml(
  baseDir: string,
  name: string,
  clinicalRecords: { sourceName: string; resourceFilePath: string }[],
): string {
  const records = clinicalRecords
    .map(
      (r) =>
        `  <ClinicalRecord sourceName="${r.sourceName}" resourceFilePath="${r.resourceFilePath}"/>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${records}
</HealthData>`;
  const xmlPath = join(baseDir, name);
  writeFileSync(xmlPath, xml, "utf8");
  return xmlPath;
}

// ============================================================
// importAppleHealthFile (XML path, non-zip)
// ============================================================

describe("importAppleHealthFile", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `import-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("imports from a raw XML path (non-zip)", async () => {
    const xmlPath = join(tmpDir, "direct.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate"
    sourceName="Watch" unit="count/min" value="72"
    startDate="2024-06-15 10:00:00 -0700"
    endDate="2024-06-15 10:00:05 -0700" />
</HealthData>`,
      "utf8",
    );
    const { db } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, xmlPath, new Date("2024-01-01"));

    expect(result.provider).toBe("apple_health");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(metricStreamReplacementCalls).toContainEqual({
      scope: {
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        recordedAtStart: new Date("2024-01-01"),
      },
      rows: [],
    });
    expect(replaceMetricStreamBatchCalls).toContainEqual({
      scope: {
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        recordedAtStart: new Date("2024-01-01"),
      },
      metricRows: [],
      sourceType: "file",
    });
  });

  it("does not import clinical records when path is not a zip", async () => {
    const xmlPath = join(tmpDir, "no-clinical.xml");
    writeFileSync(xmlPath, '<?xml version="1.0"?><HealthData locale="en_US"/>', "utf8");
    const { db } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, xmlPath, new Date("2020-01-01"));

    // Should succeed with 0 records (no clinical import for non-zip)
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("imports medication dose events as raw provider records", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-events", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "dose-1",
          startDate: "2026-06-29T15:30:00.000Z",
          endDate: "2026-06-29T15:30:00.000Z",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
          sourceName: "Apple Health",
        }),
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, zipPath, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    const allValuesCalls = spies.values.mock.calls.map(([values]) => values);
    const doseEventBatch = allValuesCalls.find((values) =>
      Array.isArray(values) ? values.some((value) => value.medicationName === "rxnorm-123") : false,
    );
    expect(doseEventBatch).toEqual([
      expect.objectContaining({
        externalId: "dose-1",
        medicationName: "rxnorm-123",
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        recordedAt: new Date("2026-06-29T15:30:00.000Z"),
        providerId: "apple_health",
        userId: "00000000-0000-0000-0000-000000000001",
        sourceName: "Apple Health",
        raw: expect.objectContaining({ uuid: "dose-1", logStatus: 1 }),
      }),
    ]);
    expect(spies.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("updates mutable medication dose fields when a provider event is reimported", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-update", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "dose-1",
          startDate: "2026-06-29T15:30:00.000Z",
          endDate: "2026-06-29T15:30:00.000Z",
          logStatus: "paused",
          medicationDisplayName: "Metformin 500 mg",
          medicationConceptIdentifier: "rxnorm-123",
          sourceName: "Apple Health Watch",
        }),
      },
    ]);
    const { db, spies } = createImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result.errors).toHaveLength(0);
    expect(spies.values).toHaveBeenCalledWith([
      expect.objectContaining({
        medicationName: "Metformin 500 mg",
        medicationConceptId: "rxnorm-123",
        doseStatus: "paused",
        recordedAt: new Date("2026-06-29T15:30:00.000Z"),
        sourceName: "Apple Health Watch",
        raw: expect.objectContaining({ uuid: "dose-1", logStatus: "paused" }),
      }),
    ]);
    expect(spies.onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.any(Array),
      set: expect.objectContaining({
        medicationName: expect.anything(),
        medicationConceptId: expect.anything(),
        doseStatus: expect.anything(),
        recordedAt: expect.anything(),
        sourceName: expect.anything(),
        raw: expect.anything(),
      }),
    });
  });

  it("derives a stable external id for medication dose events without uuid", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-events-without-uuid", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "2026-06-29T15:00:00.000Z",
          logStatus: 2,
          medicationConceptIdentifier: "rxnorm-123",
          sourceName: "Apple Health",
        }),
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, zipPath, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(0);
    const allValuesCalls = spies.values.mock.calls.map(([values]) => values);
    const doseEventBatch = allValuesCalls.find((values) =>
      Array.isArray(values)
        ? values.some((value) =>
            String(value.externalId).startsWith("apple-health-medication-dose:"),
          )
        : false,
    );
    expect(doseEventBatch).toEqual([
      expect.objectContaining({
        externalId:
          "apple-health-medication-dose:2026-06-29T15:30:00.000Z:2026-06-29T15:00:00.000Z:rxnorm-123:apple_health_export/clinical-records/MedicationDoseEvent-001.json",
        medicationName: "rxnorm-123",
        medicationConceptId: "rxnorm-123",
        doseStatus: "skipped",
      }),
    ]);
    expect(spies.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("uses display name and normalized fallback fields for medication dose events", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-display-name", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "   ",
          logStatus: " paused ",
          medicationConceptIdentifier: "   ",
          medicationDisplayName: "  Vitamin D  ",
          sourceName: "   ",
        }),
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, zipPath, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(0);
    const allValuesCalls = spies.values.mock.calls.map(([values]) => values);
    const doseEventBatch = allValuesCalls.find((values) =>
      Array.isArray(values) ? values.some((value) => value.medicationName === "Vitamin D") : false,
    );
    expect(doseEventBatch).toEqual([
      expect.objectContaining({
        externalId:
          "apple-health-medication-dose:2026-06-29T15:30:00.000Z:unscheduled:Vitamin D:apple_health_export/clinical-records/MedicationDoseEvent-001.json",
        medicationName: "Vitamin D",
        medicationConceptId: null,
        doseStatus: "paused",
        sourceName: null,
      }),
    ]);
  });

  it("keeps fallback medication dose external ids stable when dose status changes", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-status-change", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "2026-06-29T15:00:00.000Z",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
      {
        name: "MedicationDoseEvent-002.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "2026-06-29T15:00:00.000Z",
          logStatus: 2,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result.errors).toHaveLength(0);
    const doseEventBatch = spies.values.mock.calls.find(([values]) =>
      Array.isArray(values)
        ? values.some((value) => value.medicationConceptId === "rxnorm-123")
        : false,
    )?.[0];
    expect(doseEventBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId:
            "apple-health-medication-dose:2026-06-29T15:30:00.000Z:2026-06-29T15:00:00.000Z:rxnorm-123:apple_health_export/clinical-records/MedicationDoseEvent-001.json",
          doseStatus: "taken",
        }),
        expect.objectContaining({
          externalId:
            "apple-health-medication-dose:2026-06-29T15:30:00.000Z:2026-06-29T15:00:00.000Z:rxnorm-123:apple_health_export/clinical-records/MedicationDoseEvent-002.json",
          doseStatus: "skipped",
        }),
      ]),
    );
    expect(doseEventBatch).toHaveLength(2);
  });

  it("preserves duplicate medication dose events without uuids by assigning distinct fallback external ids", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-fallback-collision", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "2026-06-29T15:00:00.000Z",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
      {
        name: "MedicationDoseEvent-002.json",
        content: JSON.stringify({
          startDate: "2026-06-29T15:30:00.000Z",
          scheduledDate: "2026-06-29T15:00:00.000Z",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
    ]);
    const { db, spies } = createImportMockDb();
    spies.values.mockImplementationOnce((values) => ({
      onConflictDoNothing: spies.onConflictDoNothing,
      onConflictDoUpdate: async (config: unknown) => {
        if (!Array.isArray(values)) {
          return spies.onConflictDoUpdate(config);
        }

        const externalIds = values.map((value) => String(value.externalId));
        if (new Set(externalIds).size !== externalIds.length) {
          throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
        }

        return spies.onConflictDoUpdate(config);
      },
    }));

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 2, skipped: 0, errors: [] });
    const doseEventBatch = spies.values.mock.calls[0]?.[0];
    expect(doseEventBatch).toHaveLength(2);
    expect(doseEventBatch).toEqual([
      expect.objectContaining({
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        raw: expect.not.objectContaining({ uuid: expect.any(String) }),
      }),
      expect.objectContaining({
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        raw: expect.not.objectContaining({ uuid: expect.any(String) }),
      }),
    ]);
    const externalIds = Array.isArray(doseEventBatch)
      ? doseEventBatch.map((value) => String(value.externalId))
      : [];
    expect(new Set(externalIds).size).toBe(2);
    expect(externalIds[0]).not.toBe(externalIds[1]);
  });

  it("does not batch duplicate medication dose conflict keys into one upsert", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-duplicate-uuid", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "duplicate-dose-id",
          startDate: "2026-06-29T15:30:00.000Z",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
      {
        name: "MedicationDoseEvent-002.json",
        content: JSON.stringify({
          uuid: "duplicate-dose-id",
          startDate: "2026-06-29T15:30:00.000Z",
          logStatus: 2,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
    ]);
    const { db, spies } = createImportMockDb();
    spies.values.mockImplementation((values) => ({
      onConflictDoNothing: spies.onConflictDoNothing,
      onConflictDoUpdate: async (config: unknown) => {
        if (Array.isArray(values)) {
          const conflictKeys = values.map(
            (value) => `${value.userId}:${value.providerId}:${value.externalId}`,
          );
          if (new Set(conflictKeys).size !== conflictKeys.length) {
            throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
          }
        }

        return spies.onConflictDoUpdate(config);
      },
    }));

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 2, skipped: 0, errors: [] });
    expect(spies.values).toHaveBeenCalledWith([
      expect.objectContaining({ externalId: "duplicate-dose-id" }),
    ]);
    expect(spies.values).toHaveBeenCalledTimes(2);
  });

  it("maps string, custom, and unknown medication dose statuses from Apple Health", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-string-statuses", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "dose-string-taken",
          startDate: "2026-06-29T15:30:00.000Z",
          logStatus: "1",
          medicationConceptIdentifier: "rxnorm-taken",
        }),
      },
      {
        name: "MedicationDoseEvent-002.json",
        content: JSON.stringify({
          uuid: "dose-string-skipped",
          startDate: "2026-06-29T16:30:00.000Z",
          logStatus: "2",
          medicationConceptIdentifier: "rxnorm-skipped",
        }),
      },
      {
        name: "MedicationDoseEvent-003.json",
        content: JSON.stringify({
          uuid: "dose-custom-status",
          startDate: "2026-06-29T17:30:00.000Z",
          logStatus: " deferred ",
          medicationConceptIdentifier: "rxnorm-deferred",
        }),
      },
      {
        name: "MedicationDoseEvent-004.json",
        content: JSON.stringify({
          uuid: "dose-unknown-status",
          startDate: "2026-06-29T18:30:00.000Z",
          logStatus: 3,
          medicationConceptIdentifier: "rxnorm-unknown",
        }),
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 4, skipped: 0, errors: [] });
    const doseEventBatch = spies.values.mock.calls.find(([values]) =>
      Array.isArray(values)
        ? values.some((value) => value.externalId === "dose-string-taken")
        : false,
    )?.[0];
    expect(doseEventBatch).toHaveLength(4);
    expect(doseEventBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "dose-string-taken", doseStatus: "taken" }),
        expect.objectContaining({ externalId: "dose-string-skipped", doseStatus: "skipped" }),
        expect.objectContaining({ externalId: "dose-custom-status", doseStatus: "deferred" }),
        expect.objectContaining({ externalId: "dose-unknown-status", doseStatus: "unknown" }),
      ]),
    );
  });

  it("ignores zip entries that are not medication dose JSON files", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-entry-filter", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "dose-valid-entry",
          startDate: "2026-06-29T15:30:00.000Z",
          medicationConceptIdentifier: "rxnorm-valid",
        }),
      },
      {
        name: "Observation-001.json",
        content: "{not-json",
      },
      {
        name: "MedicationDoseEvent-ignored.txt",
        content: "{not-json",
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 1, skipped: 0, errors: [] });
    expect(spies.values).toHaveBeenCalledTimes(1);
    expect(spies.values.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ externalId: "dose-valid-entry" }),
    ]);
  });

  it("inserts medication dose events in 500-row batches", async () => {
    const doseEventFiles = Array.from({ length: 501 }, (_, index) => ({
      name: `MedicationDoseEvent-${String(index).padStart(3, "0")}.json`,
      content: JSON.stringify({
        uuid: `dose-batch-${index}`,
        startDate: new Date(Date.UTC(2026, 5, 29, 15, index)).toISOString(),
        medicationConceptIdentifier: "rxnorm-batch",
      }),
    }));
    const zipPath = createClinicalZip(tmpDir, "dose-event-batches", doseEventFiles);
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 501, skipped: 0, errors: [] });
    expect(spies.values).toHaveBeenCalledTimes(2);
    expect(spies.values.mock.calls[0]?.[0]).toHaveLength(500);
    expect(spies.values.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("returns zero medication dose counts when the export contains no dose files", async () => {
    const zipPath = createEmptyZip(tmpDir, "dose-events-empty");
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result).toEqual({ inserted: 0, skipped: 0, errors: [] });
    expect(spies.deleteFn).toHaveBeenCalledTimes(1);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(1);
    expect(spies.insertFn).not.toHaveBeenCalled();
  });

  it("reports medication dose parse errors without inserting invalid dose rows", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-invalid-json", [
      {
        name: "MedicationDoseEvent-001.json",
        content: "{not-json",
      },
    ]);
    const { db, spies } = createRunImportMockDb();

    const result = await importMedicationDoseEvents(db, "apple_health", zipPath);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("MedicationDoseEvent"),
      }),
    ]);
    expect(result.errors[0]?.message).toContain("MedicationDoseEvent-001.json");
    expect(spies.insertFn).not.toHaveBeenCalled();
  });

  it("propagates invalid medication dose dates into the import result", async () => {
    const zipPath = createClinicalZip(tmpDir, "dose-event-invalid-date", [
      {
        name: "MedicationDoseEvent-001.json",
        content: JSON.stringify({
          uuid: "dose-invalid-date",
          startDate: "not-a-date",
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-123",
        }),
      },
      {
        name: "MedicationDoseEvent-002.json",
        content: JSON.stringify({
          uuid: "dose-invalid-date-type",
          startDate: 123,
          logStatus: 1,
          medicationConceptIdentifier: "rxnorm-456",
        }),
      },
    ]);
    const { db } = createRunImportMockDb();

    const result = await importAppleHealthFile(db, zipPath, new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "MedicationDoseEvent apple_health_export/clinical-records/MedicationDoseEvent-001.json: Invalid medication dose event startDate: not-a-date",
        ),
        expect.stringContaining("MedicationDoseEvent-002.json"),
        expect.stringContaining("expected string"),
      ]),
    );
  });

  it("requires token user context for medication dose imports", async () => {
    vi.resetModules();
    vi.doMock("../../db/token-user-context.ts", () => ({
      getTokenUserId: () => null,
      runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
    }));
    const { importMedicationDoseEvents: importMedicationDoseEventsWithoutUser } = await import(
      "./import.ts"
    );
    const zipPath = createEmptyZip(tmpDir, "dose-event-no-user");
    const { db } = createRunImportMockDb();

    await expect(
      importMedicationDoseEventsWithoutUser(db, "apple_health", zipPath),
    ).rejects.toThrow("apple-health medication dose import requires user context");

    vi.doMock("../../db/token-user-context.ts", () => ({
      getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
      runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
    }));
    vi.resetModules();
  });
});

// ============================================================
// runImport
// ============================================================

function createRunImportMockDb() {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insertFn = vi.fn().mockReturnValue({ values });

  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFn = vi.fn().mockReturnValue({ from: selectFrom });

  const execute = vi.fn().mockResolvedValue([]);

  const db = makeTransactionalTestDatabase<SyncDatabase>({
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  });

  return {
    db,
    spies: {
      deleteFn,
      deleteWhere,
      insertFn,
      values,
      onConflictDoUpdate,
      onConflictDoNothing,
      execute,
    },
  };
}

describe("runImport", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `run-import-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns zero records for empty XML", async () => {
    const xmlPath = join(tmpDir, "empty-import.xml");
    writeFileSync(
      xmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><HealthData locale="en_US"></HealthData>',
      "utf8",
    );
    const { db, spies } = createRunImportMockDb();

    const result = await runImport(db, "apple_health", xmlPath, new Date("2020-01-01"));

    expect(result.provider).toBe("apple_health");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    // Should still delete existing rows
    expect(spies.deleteFn).toHaveBeenCalled();
  });

  it("imports heart rate records from XML", async () => {
    const xmlPath = join(tmpDir, "hr-import.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate"
    sourceName="Apple Watch" unit="count/min" value="72"
    startDate="2024-06-15 10:00:00 -0700"
    endDate="2024-06-15 10:00:05 -0700" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    sourceName="Apple Watch" unit="count/min" value="75"
    startDate="2024-06-15 10:01:00 -0700"
    endDate="2024-06-15 10:01:05 -0700" />
</HealthData>`,
      "utf8",
    );
    const { db } = createRunImportMockDb();

    const result = await runImport(db, "apple_health", xmlPath, new Date("2024-01-01"));

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("filters records by since date", async () => {
    const xmlPath = join(tmpDir, "since-filter.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate"
    sourceName="Watch" unit="count/min" value="72"
    startDate="2023-01-01 10:00:00 -0700"
    endDate="2023-01-01 10:00:05 -0700" />
  <Record type="HKQuantityTypeIdentifierHeartRate"
    sourceName="Watch" unit="count/min" value="75"
    startDate="2024-06-15 10:00:00 -0700"
    endDate="2024-06-15 10:00:05 -0700" />
</HealthData>`,
      "utf8",
    );
    const { db } = createRunImportMockDb();

    const result = await runImport(db, "apple_health", xmlPath, new Date("2024-01-01"));

    // Only the 2024 record should be imported
    expect(result.recordsSynced).toBe(1);
  });

  it("handles XML parse errors gracefully", async () => {
    const xmlPath = join(tmpDir, "bad-xml.xml");
    writeFileSync(xmlPath, "this is not xml at all", "utf8");
    const { db } = createRunImportMockDb();

    const result = await runImport(db, "apple_health", xmlPath, new Date("2020-01-01"));

    expect(result.errors).toHaveLength(1);
  });

  it("reports progress via callback", async () => {
    const xmlPath = join(tmpDir, "progress-import.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount"
    sourceName="iPhone" unit="count" value="1000"
    startDate="2024-06-15 10:00:00 -0700"
    endDate="2024-06-15 11:00:00 -0700" />
</HealthData>`,
      "utf8",
    );
    const { db } = createRunImportMockDb();
    const progressCalls: number[] = [];

    await runImport(db, "apple_health", xmlPath, new Date("2024-01-01"), (info) => {
      progressCalls.push(info.percentage);
    });

    // Should have received at least one progress callback ending at 100
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toBe(100);
  });

  it("does not run a post-import Postgres metric_stream activity link", async () => {
    const xmlPath = join(tmpDir, "linked-hr-import.xml");
    writeFileSync(
      xmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><HealthData locale="en_US"></HealthData>',
      "utf8",
    );
    const { db, spies } = createRunImportMockDb();
    spies.execute.mockResolvedValueOnce([{ recorded_at: "2024-06-15T10:00:00.000Z" }]);
    const loggerInfoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await runImport(db, "apple_health", xmlPath, new Date("2024-01-01"));

    expect(loggerInfoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Linked 1 heart-rate sensor rows to workouts after import"),
    );
    expect(JSON.stringify(spies.execute.mock.calls)).not.toContain("fitness.metric_stream");
  });
});

describe("runImport (control-flow mutation killers)", () => {
  function createRunImportDbForMockedStreaming(): SyncDatabase {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertFn = vi.fn().mockReturnValue({ values });
    return makeTransactionalTestDatabase<SyncDatabase>({
      delete: deleteFn,
      insert: insertFn,
      select: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    });
  }

  it("routes each record bucket and accumulates exact synced counts", async () => {
    vi.resetModules();

    const upsertMetricStreamBatch = vi.fn().mockResolvedValue(10);
    const upsertBodyMeasurementBatch = vi.fn().mockResolvedValue(20);
    const upsertDailyMetricsBatch = vi.fn().mockResolvedValue(30);
    const upsertNutritionBatch = vi.fn().mockResolvedValue(40);
    const upsertHealthEventBatch = vi.fn().mockResolvedValue(50);
    const upsertSleepBatch = vi.fn().mockResolvedValue(2);
    const upsertWorkoutBatch = vi.fn().mockResolvedValue(3);
    const aggregateSpO2ToDailyMetrics = vi.fn().mockResolvedValue(undefined);
    const aggregateSkinTempToDailyMetrics = vi.fn().mockResolvedValue(undefined);
    const finishProviderActivityListSync = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: { "metric.type": true },
      BODY_MEASUREMENT_TYPES: new Set(["body.type"]),
      DAILY_METRIC_TYPES: new Set(["daily.type"]),
      NUTRITION_TYPES: { "nutrition.type": true },
      ALL_ROUTED_TYPES: new Set(["metric.type", "body.type", "daily.type", "nutrition.type"]),
      upsertMetricStreamBatch,
      upsertBodyMeasurementBatch,
      upsertDailyMetricsBatch,
      upsertNutritionBatch,
      upsertHealthEventBatch,
      upsertSleepBatch,
      upsertWorkoutBatch,
      aggregateSpO2ToDailyMetrics,
      aggregateSkinTempToDailyMetrics,
    }));

    vi.doMock("../../db/provider-activity-sync.ts", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../db/provider-activity-sync.ts")>();
      return {
        ...original,
        finishProviderActivityListSync,
      };
    });

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string }>) => Promise<void>;
            onSleepBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onWorkoutBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onCategoryBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([
            { type: "metric.type" },
            { type: "body.type" },
            { type: "daily.type" },
            { type: "nutrition.type" },
            { type: "unknown.type" },
          ]);
          await handlers.onSleepBatch([{}]);
          await handlers.onWorkoutBatch([{ startDate: new Date("2026-03-01T10:00:00Z") }]);
          await handlers.onCategoryBatch([
            {
              metadata: {},
              sourceBundle: "com.example.watch",
              type: "category.type",
              value: "mindful",
              sourceName: "Watch",
              startDate: new Date("2026-03-01T10:00:00Z"),
              endDate: new Date("2026-03-01T10:05:00Z"),
            },
          ]);
          return { recordCount: 5, workoutCount: 1, sleepCount: 1, categoryCount: 1 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const result = await mockedRunImport(
      db,
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(156);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);

    expect(upsertMetricStreamBatch).toHaveBeenCalledTimes(1);
    expect(upsertBodyMeasurementBatch).toHaveBeenCalledTimes(1);
    expect(upsertDailyMetricsBatch).toHaveBeenCalledTimes(1);
    expect(upsertNutritionBatch).toHaveBeenCalledTimes(1);
    expect(upsertHealthEventBatch).toHaveBeenCalledTimes(1);
    expect(upsertSleepBatch).toHaveBeenCalledTimes(1);
    expect(upsertWorkoutBatch).toHaveBeenCalledTimes(1);
    expect(aggregateSpO2ToDailyMetrics).toHaveBeenCalledTimes(1);
    expect(aggregateSkinTempToDailyMetrics).toHaveBeenCalledTimes(1);
    expect(finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "apple_health",
        windowEnd: new Date("2026-03-01T10:00:00.000Z"),
        presentExternalIds: new Set(["ah:workout:2026-03-01T10:00:00.000Z"]),
      }),
    );
  });

  it("preserves category values and derives distinct stable external ids", async () => {
    vi.resetModules();

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: {},
      BODY_MEASUREMENT_TYPES: new Set<string>(),
      DAILY_METRIC_TYPES: new Set<string>(),
      NUTRITION_TYPES: {},
      ALL_ROUTED_TYPES: new Set<string>(),
      upsertMetricStreamBatch: vi.fn().mockResolvedValue(0),
      upsertBodyMeasurementBatch: vi.fn().mockResolvedValue(0),
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(0),
      aggregateSpO2ToDailyMetrics: vi.fn().mockResolvedValue(undefined),
      aggregateSkinTempToDailyMetrics: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onCategoryBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
          },
        ) => {
          const shared = {
            metadata: { HKMetadataKeyMenstrualCycleStart: true },
            sourceBundle: "com.example.cycle",
            type: "HKCategoryTypeIdentifierMenstrualFlow",
            sourceName: "Cycle Source",
            startDate: new Date("2026-03-01T10:00:00Z"),
            endDate: new Date("2026-03-01T10:05:00Z"),
          };
          await handlers.onCategoryBatch([
            { ...shared, value: "light" },
            { ...shared, value: "heavy" },
          ]);
          return { recordCount: 0, workoutCount: 0, sleepCount: 0, categoryCount: 2 };
        },
      ),
    }));

    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const db = makeTransactionalTestDatabase<SyncDatabase>({
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    });
    const { runImport: mockedRunImport } = await import("./import.ts");

    const result = await mockedRunImport(
      db,
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.recordsSynced).toBe(2);
    const categoryRows = values.mock.calls
      .map(([rows]) => rows)
      .find(
        (rows) => Array.isArray(rows) && rows[0]?.type === "HKCategoryTypeIdentifierMenstrualFlow",
      );
    expect(categoryRows).toEqual([
      expect.objectContaining({
        valueText: "light",
        externalId: expect.stringMatching(/^ah-category:[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        valueText: "heavy",
        externalId: expect.stringMatching(/^ah-category:[a-f0-9]{64}$/),
      }),
    ]);
    expect(new Set(categoryRows.map((row: { externalId: string }) => row.externalId)).size).toBe(2);
  });

  it("uses the latest workout end timestamp for reconciliation windowEnd", async () => {
    vi.resetModules();

    const finishProviderActivityListSync = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: {},
      BODY_MEASUREMENT_TYPES: new Set<string>(),
      DAILY_METRIC_TYPES: new Set<string>(),
      NUTRITION_TYPES: {},
      ALL_ROUTED_TYPES: new Set<string>(),
      upsertMetricStreamBatch: vi.fn().mockResolvedValue(0),
      upsertBodyMeasurementBatch: vi.fn().mockResolvedValue(0),
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(2),
      aggregateSpO2ToDailyMetrics: vi.fn().mockResolvedValue(undefined),
      aggregateSkinTempToDailyMetrics: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("../../db/provider-activity-sync.ts", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../db/provider-activity-sync.ts")>();
      return {
        ...original,
        finishProviderActivityListSync,
      };
    });

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string }>) => Promise<void>;
            onSleepBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onWorkoutBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onCategoryBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([]);
          await handlers.onSleepBatch([]);
          await handlers.onWorkoutBatch([
            {
              startDate: new Date("2026-03-01T10:00:00Z"),
              endDate: new Date("2026-03-01T11:00:00Z"),
            },
            {
              startDate: new Date("2026-03-01T12:00:00Z"),
              endDate: new Date("2026-03-01T13:30:00Z"),
            },
          ]);
          await handlers.onCategoryBatch([]);
          return { recordCount: 0, workoutCount: 2, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const since = new Date("2026-03-01T00:00:00Z");
    await mockedRunImport(db, "apple_health", "/tmp/stream.xml", since);

    expect(finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        windowStart: since,
        windowEnd: new Date("2026-03-01T13:30:00.000Z"),
        presentExternalIds: new Set([
          "ah:workout:2026-03-01T10:00:00.000Z",
          "ah:workout:2026-03-01T12:00:00.000Z",
        ]),
      }),
    );
  });

  it("falls back to since for reconciliation windowEnd when no workouts import", async () => {
    vi.resetModules();

    const finishProviderActivityListSync = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: {},
      BODY_MEASUREMENT_TYPES: new Set<string>(),
      DAILY_METRIC_TYPES: new Set<string>(),
      NUTRITION_TYPES: {},
      ALL_ROUTED_TYPES: new Set<string>(),
      upsertMetricStreamBatch: vi.fn().mockResolvedValue(0),
      upsertBodyMeasurementBatch: vi.fn().mockResolvedValue(0),
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(0),
      aggregateSpO2ToDailyMetrics: vi.fn().mockResolvedValue(undefined),
      aggregateSkinTempToDailyMetrics: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("../../db/provider-activity-sync.ts", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../db/provider-activity-sync.ts")>();
      return {
        ...original,
        finishProviderActivityListSync,
      };
    });

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string }>) => Promise<void>;
            onSleepBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onWorkoutBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
            onCategoryBatch: (records: Array<Record<string, unknown>>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([]);
          await handlers.onSleepBatch([]);
          await handlers.onWorkoutBatch([]);
          await handlers.onCategoryBatch([]);
          return { recordCount: 0, workoutCount: 0, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const since = new Date("2026-03-01T00:00:00Z");
    await mockedRunImport(db, "apple_health", "/tmp/stream.xml", since);

    expect(finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        windowStart: since,
        windowEnd: since,
        presentExternalIds: new Set<string>(),
      }),
    );
  });

  it("aggregates only metric records collected across multiple record batches", async () => {
    vi.resetModules();

    const firstMetricRecord = { type: "metric.type", marker: "first" };
    const secondMetricRecord = { type: "metric.type", marker: "second" };
    const bodyRecord = { type: "body.type", marker: "body" };
    const upsertMetricStreamBatch = vi.fn().mockResolvedValue(1);
    const upsertBodyMeasurementBatch = vi.fn().mockResolvedValue(1);
    const aggregateSpO2ToDailyMetrics = vi.fn().mockResolvedValue(undefined);
    const aggregateSkinTempToDailyMetrics = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: { "metric.type": true },
      BODY_MEASUREMENT_TYPES: new Set(["body.type"]),
      DAILY_METRIC_TYPES: new Set(["daily.type"]),
      NUTRITION_TYPES: { "nutrition.type": true },
      ALL_ROUTED_TYPES: new Set(["metric.type", "body.type", "daily.type", "nutrition.type"]),
      upsertMetricStreamBatch,
      upsertBodyMeasurementBatch,
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(0),
      aggregateSpO2ToDailyMetrics,
      aggregateSkinTempToDailyMetrics,
    }));

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string; marker: string }>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([firstMetricRecord]);
          await handlers.onRecordBatch([bodyRecord]);
          await handlers.onRecordBatch([secondMetricRecord]);
          return { recordCount: 3, workoutCount: 0, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const result = await mockedRunImport(
      db,
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(3);

    expect(upsertMetricStreamBatch).toHaveBeenCalledTimes(2);
    expect(upsertMetricStreamBatch).toHaveBeenCalledWith(
      db,
      "apple_health",
      [firstMetricRecord],
      expect.objectContaining({ providerId: "apple_health" }),
      undefined,
    );
    expect(upsertMetricStreamBatch).toHaveBeenCalledWith(
      db,
      "apple_health",
      [secondMetricRecord],
      expect.objectContaining({ providerId: "apple_health" }),
      undefined,
    );
    expect(upsertBodyMeasurementBatch).toHaveBeenCalledTimes(1);
    expect(upsertBodyMeasurementBatch).toHaveBeenCalledWith(
      db,
      "apple_health",
      [bodyRecord],
      expect.objectContaining({ providerId: "apple_health" }),
      undefined,
    );
    expect(aggregateSpO2ToDailyMetrics).toHaveBeenCalledTimes(1);
    expect(aggregateSpO2ToDailyMetrics).toHaveBeenCalledWith(db, "apple_health", [
      firstMetricRecord,
      secondMetricRecord,
    ]);
    expect(aggregateSkinTempToDailyMetrics).toHaveBeenCalledTimes(1);
    expect(aggregateSkinTempToDailyMetrics).toHaveBeenCalledWith(db, "apple_health", [
      firstMetricRecord,
      secondMetricRecord,
    ]);
  });

  it("skips empty record buckets and does not call unrelated upsert handlers", async () => {
    vi.resetModules();

    const upsertMetricStreamBatch = vi.fn().mockResolvedValue(1);
    const upsertBodyMeasurementBatch = vi.fn().mockResolvedValue(2);
    const upsertDailyMetricsBatch = vi.fn().mockResolvedValue(3);
    const upsertNutritionBatch = vi.fn().mockResolvedValue(4);
    const upsertHealthEventBatch = vi.fn().mockResolvedValue(5);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: { "metric.type": true },
      BODY_MEASUREMENT_TYPES: new Set(["body.type"]),
      DAILY_METRIC_TYPES: new Set(["daily.type"]),
      NUTRITION_TYPES: { "nutrition.type": true },
      ALL_ROUTED_TYPES: new Set(["metric.type", "body.type", "daily.type", "nutrition.type"]),
      upsertMetricStreamBatch,
      upsertBodyMeasurementBatch,
      upsertDailyMetricsBatch,
      upsertNutritionBatch,
      upsertHealthEventBatch,
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(0),
      aggregateSpO2ToDailyMetrics: vi.fn().mockResolvedValue(undefined),
      aggregateSkinTempToDailyMetrics: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string }>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([{ type: "metric.type" }]);
          return { recordCount: 1, workoutCount: 0, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const result = await mockedRunImport(
      db,
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    expect(upsertMetricStreamBatch).toHaveBeenCalledTimes(1);
    expect(upsertBodyMeasurementBatch).not.toHaveBeenCalled();
    expect(upsertDailyMetricsBatch).not.toHaveBeenCalled();
    expect(upsertNutritionBatch).not.toHaveBeenCalled();
    expect(upsertHealthEventBatch).not.toHaveBeenCalled();
  });

  it("reports malformed Hang Ten segments after importing the workout", async () => {
    vi.resetModules();
    const upsertWorkoutBatch = vi.fn().mockResolvedValue(1);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: {},
      BODY_MEASUREMENT_TYPES: new Set(),
      DAILY_METRIC_TYPES: new Set(),
      NUTRITION_TYPES: {},
      ALL_ROUTED_TYPES: new Set(),
      upsertMetricStreamBatch: vi.fn().mockResolvedValue(0),
      upsertBodyMeasurementBatch: vi.fn().mockResolvedValue(0),
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch,
      aggregateSpO2ToDailyMetrics: vi.fn().mockResolvedValue(undefined),
      aggregateSkinTempToDailyMetrics: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onWorkoutBatch: (workouts: Array<Record<string, unknown>>) => Promise<void>;
          },
        ) => {
          await handlers.onWorkoutBatch([
            {
              activityType: "hangboard",
              sourceName: "Hang Ten",
              durationSeconds: 600,
              startDate: new Date("2026-08-07T14:00:00Z"),
              endDate: new Date("2026-08-07T14:10:00Z"),
              hangTen: {
                planName: "Max Hangs",
                rawActivitySegments: "{not json",
                activitySegmentsError:
                  "Invalid Hang Ten activity segments JSON: could not parse JSON",
              },
            },
          ]);
          return { recordCount: 0, workoutCount: 1, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const result = await mockedRunImport(
      createRunImportDbForMockedStreaming(),
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-08-07T00:00:00Z"),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        externalId: "ah:workout:2026-08-07T14:00:00.000Z",
        message: "Invalid Hang Ten activity segments JSON: could not parse JSON",
      }),
    ]);
    expect(result.recordsSynced).toBe(1);
    expect(upsertWorkoutBatch).toHaveBeenCalledTimes(1);
  });

  it("does not run daily metric aggregation when streamed records contain no metric records", async () => {
    vi.resetModules();

    const upsertMetricStreamBatch = vi.fn().mockResolvedValue(1);
    const upsertBodyMeasurementBatch = vi.fn().mockResolvedValue(2);
    const aggregateSpO2ToDailyMetrics = vi.fn().mockResolvedValue(undefined);
    const aggregateSkinTempToDailyMetrics = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./db-insertion.ts", () => ({
      METRIC_STREAM_TYPES: { "metric.type": true },
      BODY_MEASUREMENT_TYPES: new Set(["body.type"]),
      DAILY_METRIC_TYPES: new Set(["daily.type"]),
      NUTRITION_TYPES: { "nutrition.type": true },
      ALL_ROUTED_TYPES: new Set(["metric.type", "body.type", "daily.type", "nutrition.type"]),
      upsertMetricStreamBatch,
      upsertBodyMeasurementBatch,
      upsertDailyMetricsBatch: vi.fn().mockResolvedValue(0),
      upsertNutritionBatch: vi.fn().mockResolvedValue(0),
      upsertHealthEventBatch: vi.fn().mockResolvedValue(0),
      upsertSleepBatch: vi.fn().mockResolvedValue(0),
      upsertWorkoutBatch: vi.fn().mockResolvedValue(0),
      aggregateSpO2ToDailyMetrics,
      aggregateSkinTempToDailyMetrics,
    }));

    vi.doMock("./streaming.ts", () => ({
      streamHealthExport: vi.fn(
        async (
          _xmlPath: string,
          _since: Date,
          handlers: {
            onRecordBatch: (records: Array<{ type: string }>) => Promise<void>;
          },
        ) => {
          await handlers.onRecordBatch([{ type: "body.type" }]);
          return { recordCount: 1, workoutCount: 0, sleepCount: 0, categoryCount: 0 };
        },
      ),
    }));

    const { runImport: mockedRunImport } = await import("./import.ts");
    const db = createRunImportDbForMockedStreaming();
    const result = await mockedRunImport(
      db,
      "apple_health",
      "/tmp/stream.xml",
      new Date("2026-03-01T00:00:00Z"),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    expect(upsertMetricStreamBatch).not.toHaveBeenCalled();
    expect(upsertBodyMeasurementBatch).toHaveBeenCalledTimes(1);
    expect(aggregateSpO2ToDailyMetrics).not.toHaveBeenCalled();
    expect(aggregateSkinTempToDailyMetrics).not.toHaveBeenCalled();
  });
});

// ============================================================
// extractExportXml
// ============================================================

describe("extractExportXml", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `extract-xml-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("extracts export.xml from a zip file", async () => {
    const exportDir = join(tmpDir, "good-zip", "apple_health_export");
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, "export.xml"), "<HealthData/>", "utf8");
    const zipPath = join(tmpDir, "good-zip.zip");
    execSync(`cd "${join(tmpDir, "good-zip")}" && zip -r "${zipPath}" apple_health_export/`);

    const xmlPath = await extractExportXml(zipPath);
    expect(existsSync(xmlPath)).toBe(true);
    expect(xmlPath).toContain("export.xml");
    const content = readFileSync(xmlPath, "utf8");
    expect(content).toBe("<HealthData/>");

    // Clean up temp file
    try {
      const { dirname } = await import("node:path");
      rmSync(dirname(xmlPath), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("finds export.xml in subdirectory", async () => {
    const exportDir = join(tmpDir, "nested-zip", "some_dir");
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(join(exportDir, "export.xml"), "<HealthData><Me/></HealthData>", "utf8");
    const zipPath = join(tmpDir, "nested-zip.zip");
    execSync(`cd "${join(tmpDir, "nested-zip")}" && zip -r "${zipPath}" some_dir/`);

    const xmlPath = await extractExportXml(zipPath);
    expect(existsSync(xmlPath)).toBe(true);
    const content = readFileSync(xmlPath, "utf8");
    expect(content).toContain("<HealthData>");
  });

  it("rejects when zip has no export.xml", async () => {
    const dir = join(tmpDir, "no-xml-zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.txt"), "data", "utf8");
    const zipPath = join(tmpDir, "no-xml.zip");
    execSync(`cd "${dir}" && zip -r "${zipPath}" other.txt`);

    const error = await extractExportXml(zipPath).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppleHealthImportValidationError);
    expect(error).toMatchObject({
      message:
        "Apple Health ZIP must contain export.xml; upload the original Apple Health export archive",
    });
  });

  it("rejects when zip file does not exist", async () => {
    await expect(extractExportXml(join(tmpDir, "nonexistent.zip"))).rejects.toThrow();
  });
});

// ============================================================
// defaultConsoleProgress (exercises formatBytes indirectly)
// ============================================================

describe("defaultConsoleProgress", () => {
  it("formats bytes (< 1024) and writes progress bar", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 500,
      totalBytes: 900,
      percentage: 55,
      recordCount: 10,
      workoutCount: 2,
      sleepCount: 1,
    };

    defaultConsoleProgress(info);

    expect(spy).toHaveBeenCalledTimes(1);
    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).toContain("500 B");
    expect(output).toContain("900 B");
    expect(output).toContain("55%");
    expect(output).toContain("10 records");
    expect(output).toContain("2 workouts");
    expect(output).toContain("1 sleep");
    // Progress bar: 27 full blocks (55/2 = 27.5 -> floor 27), 23 light blocks
    expect(output).toContain("\u2588".repeat(27));
    expect(output).toContain("\u2591".repeat(23));
    spy.mockRestore();
  });

  it("formats KB (>= 1024 and < 1MB)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 2048,
      totalBytes: 512000,
      percentage: 0,
      recordCount: 0,
      workoutCount: 0,
      sleepCount: 0,
    };

    defaultConsoleProgress(info);

    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).toContain("2 KB");
    expect(output).toContain("500 KB");
    spy.mockRestore();
  });

  it("formats MB (>= 1MB and < 1GB)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 5 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      percentage: 5,
      recordCount: 0,
      workoutCount: 0,
      sleepCount: 0,
    };

    defaultConsoleProgress(info);

    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).toContain("5.0 MB");
    expect(output).toContain("100.0 MB");
    spy.mockRestore();
  });

  it("formats GB (>= 1GB)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 2.5 * 1024 * 1024 * 1024,
      totalBytes: 3 * 1024 * 1024 * 1024,
      percentage: 83,
      recordCount: 0,
      workoutCount: 0,
      sleepCount: 0,
    };

    defaultConsoleProgress(info);

    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).toContain("2.50 GB");
    expect(output).toContain("3.00 GB");
    spy.mockRestore();
  });

  it("writes a newline when percentage >= 100", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 1000,
      totalBytes: 1000,
      percentage: 100,
      recordCount: 50,
      workoutCount: 5,
      sleepCount: 3,
    };

    defaultConsoleProgress(info);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe("\n");
    spy.mockRestore();
  });

  it("does not write a newline when percentage < 100", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const info: ProgressInfo = {
      bytesRead: 500,
      totalBytes: 1000,
      percentage: 50,
      recordCount: 0,
      workoutCount: 0,
      sleepCount: 0,
    };

    defaultConsoleProgress(info);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ============================================================
// importClinicalRecords
// ============================================================

describe("importClinicalRecords", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `import-clinical-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("deletes existing records before importing", async () => {
    const zipPath = createEmptyZip(tmpDir, "delete-test");
    const xmlPath = createTestXml(tmpDir, "delete-test.xml", []);
    const { db, spies } = createImportMockDb();

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(spies.deleteFn).toHaveBeenCalledTimes(1);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("returns early with zero counts when ZIP has no clinical records", async () => {
    const zipPath = createEmptyZip(tmpDir, "no-clinical");
    const xmlPath = createTestXml(tmpDir, "no-clinical.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("imports lab observations and reports into canonical FHIR storage", async () => {
    const zipPath = createClinicalZip(tmpDir, "lab-data", [
      { name: "obs-glucose-001.json", content: JSON.stringify(labObservation) },
      { name: "dr-metabolic-001.json", content: JSON.stringify(diagnosticReport) },
    ]);
    const xmlPath = createTestXml(tmpDir, "lab-data.xml", [
      {
        sourceName: "Quest Diagnostics",
        resourceFilePath: "/clinical-records/obs-glucose-001.json",
      },
    ]);

    const panelRows = [{ id: "panel-uuid-1", externalId: "dr-metabolic-001" }];
    const { db, spies } = createImportMockDb(panelRows);

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(spies.selectFn).not.toHaveBeenCalled();
    const records = spies.values.mock.calls[0]?.[0];
    const labResult = records.find(
      (record: { externalId: string }) => record.externalId === "obs-glucose-001",
    );
    expect(labResult).toMatchObject({
      clinicalType: "labResult",
      displayName: "Glucose",
      sourceName: "Quest Diagnostics",
    });
  });

  it("skips non-lab observations (vital signs)", async () => {
    const zipPath = createClinicalZip(tmpDir, "vitals-only", [
      { name: "obs-bp.json", content: JSON.stringify(vitalObservation) },
    ]);
    const xmlPath = createTestXml(tmpDir, "vitals.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("skips observations with no category", async () => {
    const zipPath = createClinicalZip(tmpDir, "no-cat", [
      { name: "obs-no-cat.json", content: JSON.stringify(observationWithNoCategory) },
    ]);
    const xmlPath = createTestXml(tmpDir, "no-cat.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles R4 category array format", async () => {
    const zipPath = createClinicalZip(tmpDir, "r4-cat", [
      { name: "obs-bun.json", content: JSON.stringify(labObservationWithArrayCategory) },
    ]);
    const xmlPath = createTestXml(tmpDir, "r4-cat.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles LAB category code (alternative to laboratory)", async () => {
    const zipPath = createClinicalZip(tmpDir, "lab-code", [
      { name: "obs-lab.json", content: JSON.stringify(labObservationWithLabCode) },
    ]);
    const xmlPath = createTestXml(tmpDir, "lab-code.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles invalid JSON files gracefully", async () => {
    const zipPath = createClinicalZip(tmpDir, "bad-json", [
      { name: "broken.json", content: "{invalid json}" },
    ]);
    const xmlPath = createTestXml(tmpDir, "bad-json.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Failed to parse");
    expect(result.errors[0]?.message).toContain("broken.json");
  });

  it("skips non-FHIR JSON (schema validation failure)", async () => {
    const zipPath = createClinicalZip(tmpDir, "non-fhir", [
      { name: "random.json", content: JSON.stringify({ foo: "bar" }) },
    ]);
    const xmlPath = createTestXml(tmpDir, "non-fhir.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles mixed valid and invalid files", async () => {
    const zipPath = createClinicalZip(tmpDir, "mixed", [
      { name: "obs-glucose.json", content: JSON.stringify(labObservation) },
      { name: "obs-bp.json", content: JSON.stringify(vitalObservation) },
      { name: "broken.json", content: "not json" },
      { name: "random.json", content: JSON.stringify({ not: "fhir" }) },
      { name: "dr-panel.json", content: JSON.stringify(diagnosticReport) },
    ]);
    const xmlPath = createTestXml(tmpDir, "mixed.xml", [
      { sourceName: "Quest", resourceFilePath: "/clinical-records/obs-glucose.json" },
    ]);

    const panelRows = [{ id: "panel-uuid-mix", externalId: "dr-metabolic-001" }];
    const { db } = createImportMockDb(panelRows);

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(2); // Lab observation and diagnostic report
    expect(result.skipped).toBe(2); // vital + non-FHIR
    expect(result.errors).toHaveLength(1); // broken JSON
  });

  it("imports lab observation without panel when no diagnostic report", async () => {
    const zipPath = createClinicalZip(tmpDir, "no-panel", [
      { name: "obs-standalone.json", content: JSON.stringify(labObservation) },
    ]);
    const xmlPath = createTestXml(tmpDir, "no-panel.xml", []);
    const { db, spies } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    // select should not be called when no panels inserted
    expect(spies.selectFn).not.toHaveBeenCalled();

    // Verify panelId is undefined
    const allValuesCalls = spies.values.mock.calls;
    const labResultBatch = allValuesCalls[allValuesCalls.length - 1]?.[0];
    expect(labResultBatch[0].panelId).toBeUndefined();
  });

  it("resolves source name from XML ClinicalRecord mapping", async () => {
    const zipPath = createClinicalZip(tmpDir, "source-name", [
      { name: "obs-glucose.json", content: JSON.stringify(labObservation) },
    ]);
    const xmlPath = createTestXml(tmpDir, "source-name.xml", [
      { sourceName: "LabCorp", resourceFilePath: "/clinical-records/obs-glucose.json" },
    ]);
    const { db, spies } = createImportMockDb();

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const allValuesCalls = spies.values.mock.calls;
    const labResultBatch = allValuesCalls[allValuesCalls.length - 1]?.[0];
    expect(labResultBatch[0].sourceName).toBe("LabCorp");
  });

  it("falls back to Unknown source name when not in XML", async () => {
    const zipPath = createClinicalZip(tmpDir, "unknown-source", [
      { name: "obs-glucose.json", content: JSON.stringify(labObservation) },
    ]);
    // XML with no matching ClinicalRecord for this file
    const xmlPath = createTestXml(tmpDir, "unknown-source.xml", []);
    const { db, spies } = createImportMockDb();

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const allValuesCalls = spies.values.mock.calls;
    const labResultBatch = allValuesCalls[allValuesCalls.length - 1]?.[0];
    expect(labResultBatch[0].sourceName).toBe("Unknown");
  });

  it("handles diagnostic report with missing date (parse error)", async () => {
    const badReport = {
      resourceType: "DiagnosticReport",
      id: "dr-no-date",
      code: { text: "Panel" },
      // Missing both effectiveDateTime and issued
    };
    const zipPath = createClinicalZip(tmpDir, "bad-report", [
      { name: "dr-bad.json", content: JSON.stringify(badReport) },
    ]);
    const xmlPath = createTestXml(tmpDir, "bad-report.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("DiagnosticReport dr-no-date");
  });

  it("inserts diagnostic report panel data", async () => {
    const zipPath = createClinicalZip(tmpDir, "panel-insert", [
      { name: "dr-panel.json", content: JSON.stringify(diagnosticReport) },
    ]);
    const xmlPath = createTestXml(tmpDir, "panel-insert.xml", []);
    const panelRows = [{ id: "panel-uuid-2", externalId: "dr-metabolic-001" }];
    const { db, spies } = createImportMockDb(panelRows);

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    // Should have inserted panel
    expect(spies.insertFn).toHaveBeenCalled();
    const panelValues = spies.values.mock.calls[0]?.[0];
    expect(Array.isArray(panelValues)).toBe(true);
    expect(panelValues[0].externalId).toBe("dr-metabolic-001");
    expect(panelValues[0].displayName).toBe("Metabolic Panel");
    expect(panelValues[0].clinicalType).toBe("labResult");
    expect(panelValues[0].providerId).toBe("test-provider");
    expect(panelValues[0].sourceName).toBe("Unknown");
  });

  it("imports MedicationRequest resources", async () => {
    const zipPath = createClinicalZip(tmpDir, "med-import", [
      { name: "MedicationRequest-001.json", content: JSON.stringify(medicationRequest) },
    ]);
    const xmlPath = createTestXml(tmpDir, "med-import.xml", [
      {
        sourceName: "UCSF Health",
        resourceFilePath: "/clinical-records/MedicationRequest-001.json",
      },
    ]);
    const { db, spies } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);

    const medication = spies.values.mock.calls[0]?.[0]?.[0];
    expect(medication).toMatchObject({
      clinicalType: "medication",
      displayName: "Cephalexin 500 mg Cap",
      externalId: "med-ceph-001",
      sourceName: "UCSF Health",
      fhir: medicationRequest,
    });
  });

  it("imports Condition resources", async () => {
    const zipPath = createClinicalZip(tmpDir, "cond-import", [
      { name: "Condition-001.json", content: JSON.stringify(conditionResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "cond-import.xml", [
      { sourceName: "UCSF Health", resourceFilePath: "/clinical-records/Condition-001.json" },
    ]);
    const { db, spies } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(spies.values.mock.calls[0]?.[0]?.[0]).toMatchObject({
      clinicalType: "condition",
      displayName: "Anxiety",
      externalId: "cond-anxiety-001",
      fhir: conditionResource,
    });
  });

  it("imports AllergyIntolerance resources", async () => {
    const zipPath = createClinicalZip(tmpDir, "allergy-import", [
      { name: "AllergyIntolerance-001.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "allergy-import.xml", [
      {
        sourceName: "UCSF Health",
        resourceFilePath: "/clinical-records/AllergyIntolerance-001.json",
      },
    ]);
    const { db, spies } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(spies.values.mock.calls[0]?.[0]?.[0]).toMatchObject({
      clinicalType: "allergy",
      displayName: "LACTASE",
      externalId: "allergy-lactase-001",
      fhir: allergyResource,
    });
  });

  it("imports mixed clinical record types together", async () => {
    const zipPath = createClinicalZip(tmpDir, "mixed-clinical", [
      { name: "obs-glucose.json", content: JSON.stringify(labObservation) },
      { name: "MedicationRequest-001.json", content: JSON.stringify(medicationRequest) },
      { name: "Condition-001.json", content: JSON.stringify(conditionResource) },
      { name: "AllergyIntolerance-001.json", content: JSON.stringify(allergyResource) },
      { name: "dr-panel.json", content: JSON.stringify(diagnosticReport) },
    ]);
    const xmlPath = createTestXml(tmpDir, "mixed-clinical.xml", [
      { sourceName: "Quest", resourceFilePath: "/clinical-records/obs-glucose.json" },
    ]);
    const panelRows = [{ id: "panel-uuid-mix2", externalId: "dr-metabolic-001" }];
    const { db } = createImportMockDb(panelRows);

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    // One canonical record for each supplied FHIR resource.
    expect(result.inserted).toBe(5);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("verifies insert call count matches clinical record types", async () => {
    const zipPath = createClinicalZip(tmpDir, "insert-count", [
      { name: "obs-glucose.json", content: JSON.stringify(labObservation) },
      { name: "dr-panel.json", content: JSON.stringify(diagnosticReport) },
      { name: "MedicationRequest-ic.json", content: JSON.stringify(medicationRequest) },
      { name: "Condition-ic.json", content: JSON.stringify(conditionResource) },
      { name: "AllergyIntolerance-ic.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "insert-count.xml", []);
    const panelRows = [{ id: "panel-uuid-ic", externalId: "dr-metabolic-001" }];
    const { db, spies } = createImportMockDb(panelRows);

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(spies.insertFn).toHaveBeenCalledTimes(1);
  });

  it("returns correct skipped count for non-lab observations in mixed import", async () => {
    const zipPath = createClinicalZip(tmpDir, "skip-count", [
      { name: "obs-vital.json", content: JSON.stringify(vitalObservation) },
      { name: "obs-no-cat.json", content: JSON.stringify(observationWithNoCategory) },
      { name: "MedicationRequest-sc.json", content: JSON.stringify(medicationRequest) },
    ]);
    const xmlPath = createTestXml(tmpDir, "skip-count.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1); // only medication
    expect(result.skipped).toBe(2); // vital + no-category observations
  });

  it("only reads JSON files from clinical-records directory", async () => {
    // Create ZIP with .json both inside and outside clinical-records/
    const contentDir = join(tmpDir, "filter-content");
    const clinicalDir = join(contentDir, "apple_health_export", "clinical-records");
    mkdirSync(clinicalDir, { recursive: true });
    writeFileSync(join(clinicalDir, "obs-lab.json"), JSON.stringify(labObservation), "utf8");
    // Non-clinical JSON at the export root — should NOT be read
    writeFileSync(
      join(contentDir, "apple_health_export", "export_cda.json"),
      JSON.stringify({ not: "fhir" }),
      "utf8",
    );
    const zipPath = join(tmpDir, "filter-test.zip");
    execSync(`cd "${contentDir}" && zip -r "${zipPath}" apple_health_export/`);
    const xmlPath = createTestXml(tmpDir, "filter.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(result.inserted).toBe(1);
    // Non-clinical JSON must not be read (skipped count stays 0)
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("counts medications, conditions, and allergies in inserted total", async () => {
    const zipMed = createClinicalZip(tmpDir, "count-med", [
      { name: "MedicationRequest-001.json", content: JSON.stringify(medicationRequest) },
    ]);
    const xmlMed = createTestXml(tmpDir, "count-med.xml", []);
    const { db: dbMed } = createImportMockDb();
    const resultMed = await importClinicalRecords(dbMed, "test-provider", zipMed, xmlMed);
    expect(resultMed.inserted).toBe(1);

    const zipCond = createClinicalZip(tmpDir, "count-cond", [
      { name: "Condition-001.json", content: JSON.stringify(conditionResource) },
    ]);
    const xmlCond = createTestXml(tmpDir, "count-cond.xml", []);
    const { db: dbCond } = createImportMockDb();
    const resultCond = await importClinicalRecords(dbCond, "test-provider", zipCond, xmlCond);
    expect(resultCond.inserted).toBe(1);

    const zipAllergy = createClinicalZip(tmpDir, "count-allergy", [
      { name: "AllergyIntolerance-001.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlAllergy = createTestXml(tmpDir, "count-allergy.xml", []);
    const { db: dbAllergy } = createImportMockDb();
    const resultAllergy = await importClinicalRecords(
      dbAllergy,
      "test-provider",
      zipAllergy,
      xmlAllergy,
    );
    expect(resultAllergy.inserted).toBe(1);
  });

  it("maps medication fields correctly from FHIR", async () => {
    const zipPath = createClinicalZip(tmpDir, "med-fields", [
      { name: "MedicationRequest-f.json", content: JSON.stringify(medicationRequest) },
    ]);
    const xmlPath = createTestXml(tmpDir, "med-fields.xml", []);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const record = spies.values.mock.calls[0]?.[0]?.[0];
    expect(record).toMatchObject({
      providerId: "test-provider",
      externalId: "med-ceph-001",
      displayName: "Cephalexin 500 mg Cap",
      clinicalType: "medication",
      fhir: medicationRequest,
    });
  });

  it("maps condition fields correctly from FHIR", async () => {
    const zipPath = createClinicalZip(tmpDir, "cond-fields", [
      { name: "Condition-f.json", content: JSON.stringify(conditionResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "cond-fields.xml", []);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const record = spies.values.mock.calls[0]?.[0]?.[0];
    expect(record).toMatchObject({
      providerId: "test-provider",
      externalId: "cond-anxiety-001",
      displayName: "Anxiety",
      clinicalType: "condition",
      fhir: conditionResource,
    });
  });

  it("maps allergy fields correctly from FHIR", async () => {
    const zipPath = createClinicalZip(tmpDir, "allergy-fields", [
      { name: "AllergyIntolerance-f.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "allergy-fields.xml", []);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const record = spies.values.mock.calls[0]?.[0]?.[0];
    expect(record).toMatchObject({
      providerId: "test-provider",
      externalId: "allergy-lactase-001",
      displayName: "LACTASE",
      clinicalType: "allergy",
      fhir: allergyResource,
    });
  });

  it("resolves source names for clinical record types from XML", async () => {
    const zipPath = createClinicalZip(tmpDir, "source-clinical", [
      { name: "MedicationRequest-s.json", content: JSON.stringify(medicationRequest) },
      { name: "Condition-s.json", content: JSON.stringify(conditionResource) },
      { name: "AllergyIntolerance-s.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "source-clinical.xml", [
      {
        sourceName: "Sutter Health",
        resourceFilePath: "/clinical-records/MedicationRequest-s.json",
      },
      { sourceName: "Quest", resourceFilePath: "/clinical-records/Condition-s.json" },
      { sourceName: "UCSF", resourceFilePath: "/clinical-records/AllergyIntolerance-s.json" },
    ]);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const records = spies.values.mock.calls[0]?.[0];
    expect(
      records.find((record: { clinicalType: string }) => record.clinicalType === "medication")
        ?.sourceName,
    ).toBe("Sutter Health");
    expect(
      records.find((record: { clinicalType: string }) => record.clinicalType === "condition")
        ?.sourceName,
    ).toBe("Quest");
    expect(
      records.find((record: { clinicalType: string }) => record.clinicalType === "allergy")
        ?.sourceName,
    ).toBe("UCSF");
  });

  it("handles MedicationRequest parse errors gracefully", async () => {
    const badMed = {
      resourceType: "MedicationRequest",
      id: "med-bad",
      medicationReference: { display: "Bad Med" },
      // dosageInstruction with timing that will cause an issue is fine,
      // but let's test with a resource that has an unexpected structure
      // by making contained have wrong resourceType
      contained: [{ resourceType: "Medication", code: { text: "Med" } }],
    };
    const zipPath = createClinicalZip(tmpDir, "med-error", [
      { name: "MedicationRequest-bad.json", content: JSON.stringify(badMed) },
    ]);
    const xmlPath = createTestXml(tmpDir, "med-error.xml", []);
    const { db } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    // Should successfully parse (no required fields missing in MedicationRequest)
    expect(result.inserted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles Condition with missing code text by using coding display", async () => {
    const condWithCoding = {
      resourceType: "Condition",
      id: "cond-coding-only",
      code: {
        coding: [{ system: "http://snomed.info/sct", display: "Back Pain", code: "161891005" }],
      },
    };
    const zipPath = createClinicalZip(tmpDir, "cond-coding", [
      { name: "Condition-coding.json", content: JSON.stringify(condWithCoding) },
    ]);
    const xmlPath = createTestXml(tmpDir, "cond-coding.xml", []);
    const { db, spies } = createImportMockDb();

    const result = await importClinicalRecords(db, "test-provider", zipPath, xmlPath);
    expect(result.inserted).toBe(1);

    expect(spies.values.mock.calls[0]?.[0]?.[0].displayName).toBe("Back Pain");
  });

  it("deletes the provider's canonical clinical records on re-import", async () => {
    const zipPath = createEmptyZip(tmpDir, "delete-clinical");
    const xmlPath = createTestXml(tmpDir, "delete-clinical.xml", []);
    const { db, spies } = createImportMockDb();

    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    expect(spies.deleteFn).toHaveBeenCalledTimes(1);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// readZipEntries
// ============================================================

describe("readZipEntries", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `read-zip-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("reads matching entries from ZIP", async () => {
    const zipPath = createClinicalZip(tmpDir, "match-test", [
      { name: "obs-001.json", content: '{"test": 1}' },
      { name: "obs-002.json", content: '{"test": 2}' },
    ]);

    const entries = await readZipEntries(
      zipPath,
      (name) => name.includes("clinical-records/") && name.endsWith(".json"),
    );

    expect(entries).toHaveLength(2);
    const parsed = entries.map((e) => JSON.parse(e.data.toString("utf-8")));
    expect(parsed).toContainEqual({ test: 1 });
    expect(parsed).toContainEqual({ test: 2 });
  });

  it("returns empty array when no entries match", async () => {
    const zipPath = createEmptyZip(tmpDir, "no-match");

    const entries = await readZipEntries(zipPath, (name) => name.endsWith(".json"));

    expect(entries).toHaveLength(0);
  });

  it("rejects when ZIP file does not exist", async () => {
    await expect(readZipEntries(join(tmpDir, "nonexistent.zip"), () => true)).rejects.toThrow();
  });

  it("includes entry file names in results", async () => {
    const zipPath = createClinicalZip(tmpDir, "names-test", [
      { name: "obs-named.json", content: '{"x": 1}' },
    ]);
    const entries = await readZipEntries(
      zipPath,
      (name) => name.includes("clinical-records/") && name.endsWith(".json"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toContain("obs-named.json");
    expect(entries[0]?.data).toBeInstanceOf(Buffer);
  });

  it("skips non-matching entries", async () => {
    const zipPath = createClinicalZip(tmpDir, "selective", [
      { name: "obs-001.json", content: '{"data": true}' },
    ]);

    // Match only .xml files — should skip the .json
    const entries = await readZipEntries(zipPath, (name) => name.endsWith(".xml"));

    // The export.xml is included by createClinicalZip
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toContain("export.xml");
  });
});

// ============================================================
// buildSourceNameMap
// ============================================================

describe("buildSourceNameMap", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `source-map-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("maps resourceFilePath to sourceName from ClinicalRecord elements", async () => {
    const xmlPath = createTestXml(tmpDir, "source-map.xml", [
      { sourceName: "Quest Diagnostics", resourceFilePath: "/clinical-records/obs-001.json" },
      { sourceName: "LabCorp", resourceFilePath: "/clinical-records/obs-002.json" },
    ]);

    const map = await buildSourceNameMap(xmlPath);

    expect(map.get("clinical-records/obs-001.json")).toBe("Quest Diagnostics");
    expect(map.get("clinical-records/obs-002.json")).toBe("LabCorp");
    expect(map.size).toBe(2);
  });

  it("returns empty map for XML with no ClinicalRecord elements", async () => {
    const xmlPath = createTestXml(tmpDir, "empty-map.xml", []);

    const map = await buildSourceNameMap(xmlPath);

    expect(map.size).toBe(0);
  });

  it("strips leading slash from resourceFilePath", async () => {
    const xmlPath = createTestXml(tmpDir, "slash.xml", [
      { sourceName: "Lab", resourceFilePath: "/path/to/file.json" },
    ]);

    const map = await buildSourceNameMap(xmlPath);

    // Key should NOT start with /
    expect(map.has("path/to/file.json")).toBe(true);
    expect(map.has("/path/to/file.json")).toBe(false);
  });

  it("ignores non-ClinicalRecord XML elements", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifier" sourceName="Device" resourceFilePath="/data/records.json"/>
  <ClinicalRecord sourceName="Quest" resourceFilePath="/clinical-records/obs.json"/>
  <Workout sourceName="Watch" resourceFilePath="/data/workout.json"/>
</HealthData>`;
    const xmlPath = join(tmpDir, "mixed-elements.xml");
    writeFileSync(xmlPath, xml, "utf8");

    const map = await buildSourceNameMap(xmlPath);

    // Only ClinicalRecord should be in the map
    expect(map.size).toBe(1);
    expect(map.get("clinical-records/obs.json")).toBe("Quest");
  });

  it("skips ClinicalRecord entries missing sourceName or resourceFilePath", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ClinicalRecord resourceFilePath="/clinical-records/no-source.json"/>
  <ClinicalRecord sourceName="Quest"/>
  <ClinicalRecord sourceName="LabCorp" resourceFilePath="/clinical-records/valid.json"/>
</HealthData>`;
    const xmlPath = join(tmpDir, "incomplete-attrs.xml");
    writeFileSync(xmlPath, xml, "utf8");

    const map = await buildSourceNameMap(xmlPath);

    // Only the entry with both attributes should be in the map
    expect(map.size).toBe(1);
    expect(map.get("clinical-records/valid.json")).toBe("LabCorp");
  });
});

// ============================================================
// findLatestExport
// ============================================================

describe("findLatestExport", () => {
  let tmpDir: string;
  const savedEnv = process.env.APPLE_HEALTH_IMPORT_DIR;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `find-export-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.APPLE_HEALTH_IMPORT_DIR = savedEnv;
    } else {
      delete process.env.APPLE_HEALTH_IMPORT_DIR;
    }
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns null when APPLE_HEALTH_IMPORT_DIR is not set", () => {
    delete process.env.APPLE_HEALTH_IMPORT_DIR;
    expect(findLatestExport()).toBeNull();
  });

  it("returns null when directory does not exist", () => {
    process.env.APPLE_HEALTH_IMPORT_DIR = join(tmpDir, "nonexistent");
    expect(findLatestExport()).toBeNull();
  });

  it("returns null when no .xml or .zip files exist", () => {
    const dir = join(tmpDir, "no-match");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.txt"), "data");
    process.env.APPLE_HEALTH_IMPORT_DIR = dir;

    expect(findLatestExport()).toBeNull();
  });

  it("returns the latest export file by modification time", () => {
    // Use file names where alphabetical order differs from mtime order
    // to ensure the sort is actually working (not just relying on fs order)
    const dir = join(tmpDir, "multi-files");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aaa-old.xml"), "old data");
    writeFileSync(join(dir, "zzz-new.zip"), "new data");
    // Force aaa-old.xml to have an old mtime
    utimesSync(join(dir, "aaa-old.xml"), new Date("2020-01-01"), new Date("2020-01-01"));
    process.env.APPLE_HEALTH_IMPORT_DIR = dir;

    const result = findLatestExport();

    // zzz-new.zip is newest by mtime, even though alphabetically last
    expect(result).toBe(join(dir, "zzz-new.zip"));
  });

  it("returns .xml file when it is the only option", () => {
    const dir = join(tmpDir, "xml-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "export.xml"), "xml data");
    process.env.APPLE_HEALTH_IMPORT_DIR = dir;

    const result = findLatestExport();

    expect(result).toBe(join(dir, "export.xml"));
  });
});
