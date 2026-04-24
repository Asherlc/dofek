# Apple Health Provider

## Export Format

Apple Health exports as a zip file containing:

```
apple_health_export/
  export.xml              — Main XML with Record, Workout, ClinicalRecord elements
  export_cda.xml          — Clinical Document Architecture (ECG, etc.)
  clinical-records/       — FHIR JSON files (Observation, DiagnosticReport, etc.)
  workout-routes/         — GPX files for workout routes
  electrocardiograms/     — ECG CSV data
```

### XML Format

The `export.xml` can be 1GB+ for users with years of data. We use a SAX streaming parser with backpressure to avoid OOM.

**Date format**: `"2024-03-01 10:30:00 -0500"` (not ISO 8601). Parse with `new Date(str)` which handles this format.

**Daily aggregation boundary**: For `daily_metrics` and `nutrition_daily`, always use the source calendar day from the raw Apple Health timestamp string (`YYYY-MM-DD`) rather than `toISOString().slice(0, 10)`. Converting through UTC can shift near-midnight local records into the next/previous day and make dashboard daily charts appear empty or delayed.

### Record Elements

```xml
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch"
  startDate="2024-03-01 10:30:00 -0500" endDate="2024-03-01 10:30:05 -0500"
  value="72" unit="count/min" />
```

We parse records into:
- **body_measurement**: Weight, body fat, BMI, blood pressure, temperature
- **metric_stream**: Heart rate, respiratory rate, SpO2, HRV
- **daily_metrics**: Steps, active/basal energy, resting HR, VO2max

### ClinicalRecord Elements

```xml
<ClinicalRecord type="HKClinicalTypeIdentifierLabResultRecord"
  identifier="..." sourceName="UCSF Health" fhirVersion="4.0.1"
  receivedDate="2025-09-05 07:59:48 -0700"
  resourceFilePath="/clinical-records/Observation-UUID.json" />
```

These are stubs — actual data is in referenced FHIR JSON files.

## Clinical Records (FHIR)

### Resource Types in Export

| Type | Count (typical) | Description |
|------|----------------|-------------|
| Observation | ~1300 | Individual lab results |
| DiagnosticReport | ~250 | Panel groupings referencing Observations |
| MedicationRequest | ~115 | Prescriptions |
| DocumentReference | ~180 | Clinical documents |
| Condition | ~25 | Diagnoses |
| AllergyIntolerance | ~3 | Allergies |

### FHIR Observation (Lab Result)

Two value formats:
- **Numeric**: `valueQuantity: { value: 145.0, unit: "mg/dL" }`
- **Text**: `valueString: "NEGATIVE"`

Reference ranges also vary:
- **Structured**: `referenceRange: [{ low: { value: 1.9, unit: "g/dL" }, high: { value: 3.7, unit: "g/dL" } }]`
- **Text only**: `referenceRange: [{ text: "<130" }]`

LOINC codes are in `code.coding[].code` where `system` is `http://loinc.org`.

### FHIR DiagnosticReport (Panel)

Groups Observations via `result[]` array:
```json
{
  "resourceType": "DiagnosticReport",
  "code": { "coding": [{ "display": "Lipid Panel", "code": "57698-3" }] },
  "result": [
    { "reference": "Observation/abc123" },
    { "reference": "Observation/def456" }
  ]
}
```

We use DiagnosticReports to populate `panel_name` on lab_result rows.

### FHIR Versions

Exports may contain both DSTU2 (1.0.2) and R4 (4.0.1) resources. Key differences:
- **Category field**: DSTU2 uses `category` (single object), R4 uses `category` (array)
- **Code system URLs**: Slightly different between versions

### Multiple Health Systems

A single export may contain records from multiple health systems (e.g., UCSF Health, Sutter Health, Quest Diagnostics). The `sourceName` attribute on `ClinicalRecord` and the `subject.display` field in FHIR resources identify the source.

## Provider ID Unification

As of migration `0037`, the `apple_health_kit` provider ID (iOS HealthKit live sync) was consolidated into `apple_health` (XML export import). Both are ingestion paths for the same Apple Watch data, so they now share a single provider ID. The migration merges overlapping `daily_metrics` rows with `COALESCE`, preferring XML export values.

## Workout Source Attribution

Apple Health workouts can preserve the upstream app name inside the workout JSON (`raw.sourceName`) even when the canonical `source_name` column is null. In production this is how workouts imported through Apple Health can still identify apps like Strong or WHOOP on the activity detail page.

This attribution is still workout-level only. For Strong-backed Apple Health workouts, the stored JSON can tell us that the workout came from Strong, but it does **not** include per-exercise details like exercise names, sets, reps, or weights. That richer breakdown only exists in the Strong CSV/import path.

## Heart Rate Variability (HRV) Selection

Apple Watch records SDNN (the standard HRV metric) during both overnight sleep and Breathe/Mindfulness sessions. Breathe session values are typically ~2x the overnight baseline because deliberate slow breathing maximises parasympathetic tone.

To avoid this inflation, both ingestion paths (XML import and iOS HealthKit sync) select the **earliest reading of each day** rather than averaging or taking the latest. Overnight/early-morning readings come first chronologically and reflect resting autonomic status. This logic lives in `packages/heart-rate-variability/src/heart-rate-variability.ts` (`selectDailyHeartRateVariability`).

## Import

### CLI

```bash
./scripts/with-env.sh tsx src/index.ts import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]
```

### Backpressure

The SAX parser reads much faster than the DB can write. We implement backpressure by pausing/resuming the file stream when pending DB writes exceed a threshold (MAX_PENDING = 2). Without this, full imports OOM at ~1.3M records.

### Batch Inserts

metric_stream rows are collected into batches (500 rows) and inserted with `onConflictDoNothing()` for deduplication.

### Clinical Records Import

The clinical records import runs after the XML import:
1. Read FHIR JSON files from `clinical-records/` directory in the zip (via yauzl)
2. Separate Observations from DiagnosticReports
3. Build panel map from DiagnosticReports (maps Observation IDs → panel names)
4. Stream `export.xml` with SAX to build source name map (ClinicalRecord `resourceFilePath` → `sourceName`)
5. Filter to lab-category Observations only
6. Parse and batch-insert into `lab_result` table (500 per batch)

The source name map uses SAX streaming — the export.xml can be 2.5GB and must not be loaded into memory. The SAX parser fires `opentag` for each `<ClinicalRecord>` element and extracts only the `sourceName` and `resourceFilePath` attributes.
