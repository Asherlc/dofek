import { execSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import {
  buildSourceNameMap,
  defaultConsoleProgress,
  findLatestExport,
  importClinicalRecords,
  readZipEntries,
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

  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insertFn = vi.fn().mockReturnValue({ values });

  // select().from().where() must be directly awaitable (returns Promise)
  const selectWhere = vi.fn().mockResolvedValue(panelRows);
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFn = vi.fn().mockReturnValue({ from: selectFrom });

  const execute = vi.fn().mockResolvedValue([]);

  const db: SyncDatabase = {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  };

  return {
    db,
    spies: {
      deleteFn,
      deleteWhere,
      insertFn,
      values,
      onConflictDoNothing,
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

    // Should delete lab_result, lab_panel, medication, condition, allergy_intolerance
    expect(spies.deleteFn).toHaveBeenCalledTimes(5);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(5);
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

  it("imports lab observations and links to diagnostic report panels", async () => {
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

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Should have queried back panel IDs
    expect(spies.selectFn).toHaveBeenCalled();

    // Verify panel ID was resolved in the lab result
    const allValuesCalls = spies.values.mock.calls;
    // Last values() call is the lab result batch
    const labResultBatch = allValuesCalls[allValuesCalls.length - 1]?.[0];
    expect(Array.isArray(labResultBatch)).toBe(true);
    expect(labResultBatch[0].panelId).toBe("panel-uuid-1");
    expect(labResultBatch[0].externalId).toBe("obs-glucose-001");
    expect(labResultBatch[0].sourceName).toBe("Quest Diagnostics");
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

    expect(result.inserted).toBe(1); // Only lab observation
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
    expect(panelValues[0].name).toBe("Metabolic Panel");
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

    const allValuesCalls = spies.values.mock.calls;
    const medicationBatch = allValuesCalls.find(
      (call) => call[0]?.[0]?.name === "Cephalexin 500 mg Cap",
    )?.[0];
    expect(medicationBatch).toBeDefined();
    expect(medicationBatch[0].rxnormCode).toBe("2231");
    expect(medicationBatch[0].sourceName).toBe("UCSF Health");
    expect(medicationBatch[0].prescriberName).toBe("Dr. Smith");
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

    const allValuesCalls = spies.values.mock.calls;
    const conditionBatch = allValuesCalls.find((call) => call[0]?.[0]?.name === "Anxiety")?.[0];
    expect(conditionBatch).toBeDefined();
    expect(conditionBatch[0].icd10Code).toBe("F41.9");
    expect(conditionBatch[0].snomedCode).toBe("48694002");
    expect(conditionBatch[0].clinicalStatus).toBe("active");
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

    const allValuesCalls = spies.values.mock.calls;
    const allergyBatch = allValuesCalls.find((call) => call[0]?.[0]?.name === "LACTASE")?.[0];
    expect(allergyBatch).toBeDefined();
    expect(allergyBatch[0].type).toBe("allergy");
    expect(allergyBatch[0].rxnormCode).toBe("41397");
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

    // 1 lab + 1 medication + 1 condition + 1 allergy = 4
    expect(result.inserted).toBe(4);
    expect(result.errors).toHaveLength(0);
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

    const allValuesCalls = spies.values.mock.calls;
    const batch = allValuesCalls.find((call) => call[0]?.[0]?.externalId === "med-ceph-001")?.[0];
    expect(batch).toBeDefined();
    expect(batch[0]).toMatchObject({
      providerId: "test-provider",
      externalId: "med-ceph-001",
      name: "Cephalexin 500 mg Cap",
      status: "stopped",
      authoredOn: "2024-01-10",
      dosageText: "Take 1 capsule 2x daily",
      route: "Oral",
      form: "Capsule",
      rxnormCode: "2231",
      prescriberName: "Dr. Smith",
    });
  });

  it("maps condition fields correctly from FHIR", async () => {
    const zipPath = createClinicalZip(tmpDir, "cond-fields", [
      { name: "Condition-f.json", content: JSON.stringify(conditionResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "cond-fields.xml", []);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const allValuesCalls = spies.values.mock.calls;
    const batch = allValuesCalls.find(
      (call) => call[0]?.[0]?.externalId === "cond-anxiety-001",
    )?.[0];
    expect(batch).toBeDefined();
    expect(batch[0]).toMatchObject({
      providerId: "test-provider",
      externalId: "cond-anxiety-001",
      name: "Anxiety",
      clinicalStatus: "active",
      verificationStatus: "confirmed",
      icd10Code: "F41.9",
      snomedCode: "48694002",
      onsetDate: "2023-06-02",
    });
  });

  it("maps allergy fields correctly from FHIR", async () => {
    const zipPath = createClinicalZip(tmpDir, "allergy-fields", [
      { name: "AllergyIntolerance-f.json", content: JSON.stringify(allergyResource) },
    ]);
    const xmlPath = createTestXml(tmpDir, "allergy-fields.xml", []);
    const { db, spies } = createImportMockDb();
    await importClinicalRecords(db, "test-provider", zipPath, xmlPath);

    const allValuesCalls = spies.values.mock.calls;
    const batch = allValuesCalls.find(
      (call) => call[0]?.[0]?.externalId === "allergy-lactase-001",
    )?.[0];
    expect(batch).toBeDefined();
    expect(batch[0]).toMatchObject({
      providerId: "test-provider",
      externalId: "allergy-lactase-001",
      name: "LACTASE",
      type: "allergy",
      clinicalStatus: "active",
      rxnormCode: "41397",
      onsetDate: "2023-03-27",
    });
    expect(batch[0].reactions).toEqual([
      { manifestation: "GI distress", description: "GI distress" },
    ]);
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

    const allValuesCalls = spies.values.mock.calls;
    const medBatch = allValuesCalls.find(
      (call) => call[0]?.[0]?.externalId === "med-ceph-001",
    )?.[0];
    expect(medBatch?.[0].sourceName).toBe("Sutter Health");

    const condBatch = allValuesCalls.find(
      (call) => call[0]?.[0]?.externalId === "cond-anxiety-001",
    )?.[0];
    expect(condBatch?.[0].sourceName).toBe("Quest");

    const allergyBatch = allValuesCalls.find(
      (call) => call[0]?.[0]?.externalId === "allergy-lactase-001",
    )?.[0];
    expect(allergyBatch?.[0].sourceName).toBe("UCSF");
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
