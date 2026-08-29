import { daysBefore, round, type Sql, timestampAt, USER_ID } from "./helpers.ts";

export async function seedBodyHealth(sql: Sql): Promise<void> {
  const today = new Date();
  await seedDexaScans(sql, today);
  await seedLabs(sql, today);
  await seedClinicalRecords(sql, today);
  console.log("Seeded: body composition, labs, and clinical records");
}

async function seedDexaScans(sql: Sql, today: Date): Promise<void> {
  for (const [scanIndex, daysAgo] of [150, 15].entries()) {
    const date = daysBefore(today, daysAgo);
    const bodyFatPct = scanIndex === 0 ? 18.6 : 16.8;
    const totalMassKg = scanIndex === 0 ? 82.8 : 80.4;
    const [{ id: scanId }] = await sql<{ id: string }[]>`
      INSERT INTO fitness.dexa_scan (
        provider_id, user_id, external_id, recorded_at, scanner_model,
        total_fat_mass_kg, total_lean_mass_kg, total_bone_mass_kg, total_mass_kg,
        body_fat_pct, android_gynoid_ratio, visceral_fat_mass_kg,
        visceral_fat_volume_cm3, total_bone_mineral_density,
        bone_density_t_percentile, bone_density_z_percentile,
        height_inches, weight_pounds
      ) VALUES (
        'bodyspec', ${USER_ID}, ${`seed-dexa-${scanIndex + 1}`}, ${timestampAt(date, 9, 30)},
        'Hologic Horizon Review', ${round((totalMassKg * bodyFatPct) / 100, 2)},
        ${round(totalMassKg * 0.77, 2)}, 3.1, ${totalMassKg}, ${bodyFatPct},
        ${scanIndex === 0 ? 0.98 : 0.91}, ${scanIndex === 0 ? 0.62 : 0.48},
        ${scanIndex === 0 ? 620 : 480}, ${scanIndex === 0 ? 1.18 : 1.21},
        ${scanIndex === 0 ? 68 : 73}, ${scanIndex === 0 ? 71 : 76},
        70.5, ${round(totalMassKg * 2.20462, 1)}
      ) RETURNING id
    `;
    await seedDexaRegions(sql, scanId, scanIndex);
  }
}

async function seedDexaRegions(sql: Sql, scanId: string, scanIndex: number): Promise<void> {
  const regions = [
    "android",
    "gynoid",
    "left_arm",
    "right_arm",
    "left_leg",
    "right_leg",
    "trunk",
  ] as const;
  for (const [index, region] of regions.entries()) {
    await sql`
      INSERT INTO fitness.dexa_scan_region (
        scan_id, region, fat_mass_kg, lean_mass_kg, bone_mass_kg, total_mass_kg,
        tissue_fat_pct, region_fat_pct, bone_mineral_density, bone_area_cm2,
        bone_mineral_content_g, z_score_percentile, t_score_percentile
      ) VALUES (
        ${scanId}, ${region}, ${round(1.2 + index * 0.8 - scanIndex * 0.1, 2)},
        ${round(3.4 + index * 1.7 + scanIndex * 0.15, 2)}, ${round(0.18 + index * 0.06, 2)},
        ${round(4.8 + index * 2.3, 2)}, ${round(14 + index * 1.8 - scanIndex, 1)},
        ${round(8 + index * 2.1, 1)}, ${round(1.02 + index * 0.02, 2)},
        ${round(72 + index * 11, 1)}, ${round(74 + index * 8, 1)},
        ${68 + index}, ${66 + index}
      )
    `;
  }
}

async function seedLabs(sql: Sql, today: Date): Promise<void> {
  for (const [panelIndex, daysAgo] of [120, 20].entries()) {
    const date = daysBefore(today, daysAgo);
    const panelExternalId = `seed-lab-panel-${panelIndex + 1}`;
    const recordedAt = timestampAt(date, 8, 0);
    const issuedAt = timestampAt(date, 11, 30);
    await sql`
      INSERT INTO fitness.clinical_record (
        user_id, provider_id, external_id, clinical_type, display_name, source_name,
        fhir_version, fhir, downloaded_at, recorded_at, issued_at
      ) VALUES (
        ${USER_ID}, 'apple_health', ${panelExternalId}, 'labResult',
        'Review Wellness Panel', 'Apple Health FHIR Review Seed', 'R4',
        jsonb_build_object(
          'resourceType', 'DiagnosticReport',
          'id', ${panelExternalId},
          'status', 'final',
          'code', jsonb_build_object('text', 'Review Wellness Panel'),
          'effectiveDateTime', ${recordedAt}::text,
          'issued', ${issuedAt}::text
        ),
        NOW(), ${recordedAt}, ${issuedAt}
      )
    `;

    const results = [
      ["Total Cholesterol", "209", "mg/dL", 125, 200],
      ["HDL Cholesterol", "62", "mg/dL", 40, 90],
      ["LDL Cholesterol", panelIndex === 0 ? "126" : "108", "mg/dL", 0, 130],
      ["Hemoglobin A1c", panelIndex === 0 ? "5.4" : "5.2", "%", 4, 5.7],
      ["Vitamin D", panelIndex === 0 ? "31" : "44", "ng/mL", 30, 80],
    ] as const;

    for (const [
      resultIndex,
      [testName, valueText, unit, referenceRangeLow, referenceRangeHigh],
    ] of results.entries()) {
      await sql`
        INSERT INTO fitness.clinical_record (
          user_id, provider_id, external_id, clinical_type, display_name, source_name,
          fhir_version, fhir, downloaded_at, recorded_at, issued_at
        ) VALUES (
          ${USER_ID}, 'apple_health',
          ${`seed-lab-${panelIndex + 1}-${resultIndex + 1}`}, 'labResult',
          ${testName}, 'Apple Health FHIR Review Seed', 'R4',
          jsonb_build_object(
            'resourceType', 'Observation',
            'id', ${`seed-lab-${panelIndex + 1}-${resultIndex + 1}`},
            'status', 'final',
            'category', jsonb_build_array(jsonb_build_object(
              'coding', jsonb_build_array(jsonb_build_object('code', 'laboratory'))
            )),
            'code', jsonb_build_object('text', ${testName}),
            'valueQuantity', jsonb_build_object('value', ${Number(valueText)}, 'unit', ${unit}),
            'referenceRange', jsonb_build_array(jsonb_build_object(
              'low', jsonb_build_object('value', ${referenceRangeLow}, 'unit', ${unit}),
              'high', jsonb_build_object('value', ${referenceRangeHigh}, 'unit', ${unit})
            )),
            'effectiveDateTime', ${timestampAt(date, 8, resultIndex)}::text,
            'issued', ${issuedAt}::text
          ),
          NOW(), ${timestampAt(date, 8, resultIndex)}, ${issuedAt}
        )
      `;
    }
  }
}

async function seedClinicalRecords(sql: Sql, today: Date): Promise<void> {
  await sql`
    INSERT INTO fitness.clinical_record (
      user_id, provider_id, external_id, clinical_type, display_name, source_name,
      fhir_version, fhir, downloaded_at, recorded_at, issued_at
    ) VALUES (
      ${USER_ID}, 'apple_health', 'seed-medication-1', 'medication',
      'Albuterol inhaler', 'Apple Health FHIR Review Seed', 'R4',
      jsonb_build_object(
        'resourceType', 'MedicationRequest', 'id', 'seed-medication-1', 'status', 'active',
        'medicationCodeableConcept', jsonb_build_object('text', 'Albuterol inhaler'),
        'authoredOn', ${daysBefore(today, 400)}::text,
        'dosageInstruction', jsonb_build_array(jsonb_build_object('text', '2 puffs as needed'))
      ),
      NOW(), ${daysBefore(today, 390)}, ${daysBefore(today, 400)}
    )
  `;
  await sql`
    INSERT INTO fitness.clinical_record (
      user_id, provider_id, external_id, clinical_type, display_name, source_name,
      fhir_version, fhir, downloaded_at, recorded_at
    ) VALUES (
      ${USER_ID}, 'apple_health', 'seed-condition-1', 'condition',
      'Mild exercise induced asthma', 'Apple Health FHIR Review Seed', 'R4',
      jsonb_build_object(
        'resourceType', 'Condition', 'id', 'seed-condition-1',
        'clinicalStatus', jsonb_build_object('text', 'active'),
        'verificationStatus', jsonb_build_object('text', 'confirmed'),
        'code', jsonb_build_object('text', 'Mild exercise induced asthma'),
        'onsetDateTime', ${daysBefore(today, 900)}::text,
        'recordedDate', ${daysBefore(today, 390)}::text
      ),
      NOW(), ${daysBefore(today, 390)}
    )
  `;
  await sql`
    INSERT INTO fitness.clinical_record (
      user_id, provider_id, external_id, clinical_type, display_name, source_name,
      fhir_version, fhir, downloaded_at, recorded_at
    ) VALUES (
      ${USER_ID}, 'apple_health', 'seed-allergy-1', 'allergy',
      'Penicillin', 'Apple Health FHIR Review Seed', 'R4',
      jsonb_build_object(
        'resourceType', 'AllergyIntolerance', 'id', 'seed-allergy-1', 'type', 'allergy',
        'clinicalStatus', jsonb_build_object('text', 'active'),
        'verificationStatus', jsonb_build_object('text', 'confirmed'),
        'code', jsonb_build_object('text', 'Penicillin'),
        'onsetDateTime', ${daysBefore(today, 1200)}::text,
        'reaction', jsonb_build_array(jsonb_build_object(
          'manifestation', jsonb_build_array(jsonb_build_object('text', 'Rash')),
          'severity', 'mild'
        ))
      ),
      NOW(), ${daysBefore(today, 1200)}
    )
  `;

  for (let daysAgo = 0; daysAgo < 14; daysAgo += 2) {
    const date = daysBefore(today, daysAgo);
    await sql`
      INSERT INTO fitness.medication_dose_event (
        provider_id, user_id, external_id, medication_name, dose_status,
        recorded_at, source_name
      ) VALUES (
        'apple_health', ${USER_ID}, ${`seed-dose-${daysAgo}`}, 'Vitamin D3', 'taken',
        ${timestampAt(date, 8, 0)}, 'Apple Health Review Seed'
      )
    `;
  }
}
