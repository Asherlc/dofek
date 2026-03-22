import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import {
  buildSourceNameMap,
  findLatestExport,
  importClinicalRecords,
  readZipEntries,
} from "./import.ts";

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

    // Should delete lab_result then lab_panel
    expect(spies.deleteFn).toHaveBeenCalledTimes(2);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(2);
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
    const dir = join(tmpDir, "multi-files");
    mkdirSync(dir, { recursive: true });
    // Create files with slightly different modification times
    writeFileSync(join(dir, "old-export.xml"), "old data");
    // Touch the second file slightly later
    writeFileSync(join(dir, "new-export.zip"), "new data");
    process.env.APPLE_HEALTH_IMPORT_DIR = dir;

    const result = findLatestExport();

    expect(result).not.toBeNull();
    // Should be the .zip file (created last)
    expect(result).toContain("new-export.zip");
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
