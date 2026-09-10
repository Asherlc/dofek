import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../../src/db/test-helpers.ts";
import { seedBodyHealth } from "./body-health.ts";
import { seedCore } from "./core.ts";
import { USER_ID } from "./helpers.ts";

describe("review body-health seed", () => {
  let context: TestContext;
  let sql: TaggedQueryClient;

  beforeAll(async () => {
    context = await setupTestDatabase();
    sql = createTaggedQueryClient(context.connectionString);
    await seedCore(sql);
    await seedBodyHealth(sql);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await context?.cleanup();
  });

  it("seeds canonical synthetic FHIR for every supported clinical type", async () => {
    const records = await sql<
      Array<{ clinical_type: string; resource_type: string; source_name: string | null }>
    >`
      SELECT DISTINCT
        clinical_type,
        fhir->>'resourceType' AS resource_type,
        source_name
      FROM fitness.clinical_record
      WHERE user_id = ${USER_ID}
      ORDER BY clinical_type, resource_type
    `;

    expect(records).toEqual([
      {
        clinical_type: "allergy",
        resource_type: "AllergyIntolerance",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "clinicalNote",
        resource_type: "DocumentReference",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "condition",
        resource_type: "Condition",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "coverage",
        resource_type: "Coverage",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "immunization",
        resource_type: "Immunization",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "labResult",
        resource_type: "DiagnosticReport",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "labResult",
        resource_type: "Observation",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "medication",
        resource_type: "MedicationRequest",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "procedure",
        resource_type: "Procedure",
        source_name: "Demo data — synthetic",
      },
      {
        clinical_type: "vitalSign",
        resource_type: "Observation",
        source_name: "Demo data — synthetic",
      },
    ]);
  });
});
