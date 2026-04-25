import { daysBefore, round, type SeedRandom, type Sql, timestampAt, USER_ID } from "./helpers.ts";

interface IdRow {
  id: string;
}

export async function seedBodyHealth(sql: Sql, random: SeedRandom): Promise<void> {
  const today = new Date();
  await seedBodyMeasurements(sql, random, today);
  await seedDexaScans(sql, today);
  await seedLabs(sql, today);
  await seedClinicalRecords(sql, today);
  await seedMenstrualPeriods(sql, today);
  console.log("Seeded: body composition, labs, clinical records, and cycle data");
}

async function seedBodyMeasurements(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  let weightKg = 82.4;
  for (let daysAgo = 180; daysAgo >= 0; daysAgo -= 3) {
    if (daysAgo % 39 === 0) continue;
    const date = daysBefore(today, daysAgo);
    weightKg += random.float(-0.18, 0.12, 2);
    const bodyFatPct = 18.4 - (180 - daysAgo) * 0.012 + random.float(-0.25, 0.25, 2);
    await sql`
      INSERT INTO fitness.body_measurement (
        provider_id, user_id, external_id, recorded_at, weight_kg, body_fat_pct,
        muscle_mass_kg, bone_mass_kg, water_pct, bmi, height_cm,
        waist_circumference_cm, systolic_bp, diastolic_bp, heart_pulse,
        temperature_c, source_name
      ) VALUES (
        'apple_health', ${USER_ID}, ${`seed-body-${daysAgo}`}, ${timestampAt(date, 7, 20)},
        ${round(weightKg, 2)}, ${round(bodyFatPct, 2)}, ${round(weightKg * 0.48, 2)},
        3.2, ${random.float(54, 59, 1)}, ${round(weightKg / 3.1329, 1)}, 179,
        ${random.float(82, 88, 1)}, ${random.int(108, 124)}, ${random.int(65, 78)},
        ${random.int(48, 58)}, ${random.float(36.2, 36.8, 1)}, 'Apple Health Review Seed'
      )
    `;
  }
}

async function seedDexaScans(sql: Sql, today: Date): Promise<void> {
  for (const [scanIndex, daysAgo] of [150, 15].entries()) {
    const date = daysBefore(today, daysAgo);
    const bodyFatPct = scanIndex === 0 ? 18.6 : 16.8;
    const totalMassKg = scanIndex === 0 ? 82.8 : 80.4;
    const [{ id: scanId }] = await sql<IdRow[]>`
      INSERT INTO fitness.dexa_scan (
        provider_id, user_id, external_id, recorded_at, scanner_model,
        total_fat_mass_kg, total_lean_mass_kg, total_bone_mass_kg, total_mass_kg,
        body_fat_pct, android_gynoid_ratio, visceral_fat_mass_kg,
        visceral_fat_volume_cm3, total_bone_mineral_density,
        bone_density_t_percentile, bone_density_z_percentile,
        resting_metabolic_rate_kcal, height_inches, weight_pounds
      ) VALUES (
        'bodyspec', ${USER_ID}, ${`seed-dexa-${scanIndex + 1}`}, ${timestampAt(date, 9, 30)},
        'Hologic Horizon Review', ${round((totalMassKg * bodyFatPct) / 100, 2)},
        ${round(totalMassKg * 0.77, 2)}, 3.1, ${totalMassKg}, ${bodyFatPct},
        ${scanIndex === 0 ? 0.98 : 0.91}, ${scanIndex === 0 ? 0.62 : 0.48},
        ${scanIndex === 0 ? 620 : 480}, ${scanIndex === 0 ? 1.18 : 1.21},
        ${scanIndex === 0 ? 68 : 73}, ${scanIndex === 0 ? 71 : 76},
        ${scanIndex === 0 ? 1_810 : 1_840}, 70.5, ${round(totalMassKg * 2.20462, 1)}
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
    const [{ id: panelId }] = await sql<IdRow[]>`
      INSERT INTO fitness.lab_panel (
        provider_id, user_id, external_id, name, status, source_name, recorded_at, issued_at
      ) VALUES (
        'apple_health', ${USER_ID}, ${`seed-lab-panel-${panelIndex + 1}`},
        'Review Wellness Panel', 'final', 'Apple Health FHIR Review Seed',
        ${timestampAt(date, 8, 0)}, ${timestampAt(date, 11, 30)}
      ) RETURNING id
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
        INSERT INTO fitness.lab_result (
          provider_id, user_id, panel_id, external_id, test_name, value, value_text,
          unit, reference_range_low, reference_range_high, status, source_name,
          recorded_at, issued_at
        ) VALUES (
          'apple_health', ${USER_ID}, ${panelId}, ${`seed-lab-${panelIndex + 1}-${resultIndex + 1}`},
          ${testName}, ${Number(valueText)}, ${valueText}, ${unit}, ${referenceRangeLow},
          ${referenceRangeHigh}, 'final', 'Apple Health FHIR Review Seed',
          ${timestampAt(date, 8, resultIndex)}, ${timestampAt(date, 11, 30)}
        )
      `;
    }
  }
}

async function seedClinicalRecords(sql: Sql, today: Date): Promise<void> {
  await sql`
    INSERT INTO fitness.medication (
      provider_id, user_id, external_id, name, status, authored_on, start_date,
      dosage_text, route, form, prescriber_name, reason_text, source_name
    ) VALUES (
      'apple_health', ${USER_ID}, 'seed-medication-1', 'Albuterol inhaler', 'active',
      ${daysBefore(today, 400)}, ${daysBefore(today, 390)}, '2 puffs as needed',
      'inhalation', 'inhaler', 'Review Clinic', 'Exercise induced bronchospasm',
      'Apple Health FHIR Review Seed'
    )
  `;
  await sql`
    INSERT INTO fitness.condition (
      provider_id, user_id, external_id, name, clinical_status, verification_status,
      icd10_code, onset_date, recorded_date, source_name
    ) VALUES (
      'apple_health', ${USER_ID}, 'seed-condition-1', 'Mild exercise induced asthma',
      'active', 'confirmed', 'J45.990', ${daysBefore(today, 900)}, ${daysBefore(today, 390)},
      'Apple Health FHIR Review Seed'
    )
  `;
  await sql`
    INSERT INTO fitness.allergy_intolerance (
      provider_id, user_id, external_id, name, type, clinical_status,
      verification_status, onset_date, reactions, source_name
    ) VALUES (
      'apple_health', ${USER_ID}, 'seed-allergy-1', 'Penicillin', 'allergy',
      'active', 'confirmed', ${daysBefore(today, 1200)},
      '[{"manifestation":"Rash","severity":"mild"}]'::jsonb,
      'Apple Health FHIR Review Seed'
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

async function seedMenstrualPeriods(sql: Sql, today: Date): Promise<void> {
  for (let periodIndex = 0; periodIndex < 6; periodIndex++) {
    const startDaysAgo = 12 + periodIndex * 29;
    const startDate = daysBefore(today, startDaysAgo);
    const endDate = daysBefore(today, startDaysAgo - 4);
    await sql`
      INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
      VALUES (${USER_ID}, ${startDate}, ${endDate}, 'Review seed cycle data')
      ON CONFLICT (user_id, start_date) DO UPDATE
        SET end_date = EXCLUDED.end_date,
            notes = EXCLUDED.notes
    `;
  }
}
