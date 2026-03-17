import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  activity,
  activityInterval,
  authAccount,
  bodyMeasurement,
  DEFAULT_USER_ID,
  dailyMetrics,
  exercise,
  exerciseAlias,
  foodCategoryEnum,
  foodEntry,
  healthEvent,
  journalEntry,
  labResult,
  labResultStatusEnum,
  lifeEvents,
  mealEnum,
  metricStream,
  nutritionDaily,
  oauthToken,
  provider,
  session,
  setTypeEnum,
  slackInstallation,
  sleepSession,
  sportSettings,
  strengthSet,
  strengthWorkout,
  syncLog,
  userProfile,
  userSettings,
} from "./schema.ts";

describe("DEFAULT_USER_ID", () => {
  it("equals the expected UUID", () => {
    expect(DEFAULT_USER_ID).toBe("00000000-0000-0000-0000-000000000001");
  });
});

describe("enums", () => {
  it("mealEnum has correct values", () => {
    expect(mealEnum.enumValues).toEqual(["breakfast", "lunch", "dinner", "snack", "other"]);
  });

  it("foodCategoryEnum has correct values", () => {
    expect(foodCategoryEnum.enumValues).toEqual([
      "beans_and_legumes",
      "beverages",
      "breads_and_cereals",
      "cheese_milk_and_dairy",
      "eggs",
      "fast_food",
      "fish_and_seafood",
      "fruit",
      "meat",
      "nuts_and_seeds",
      "pasta_rice_and_noodles",
      "salads",
      "sauces_spices_and_spreads",
      "snacks",
      "soups",
      "sweets_candy_and_desserts",
      "vegetables",
      "supplement",
      "other",
    ]);
  });

  it("setTypeEnum has correct values", () => {
    expect(setTypeEnum.enumValues).toEqual(["working", "warmup", "dropset", "failure"]);
  });

  it("labResultStatusEnum has correct values", () => {
    expect(labResultStatusEnum.enumValues).toEqual([
      "final",
      "preliminary",
      "corrected",
      "cancelled",
    ]);
  });
});

describe("userProfile table", () => {
  it("has correct table name", () => {
    expect(getTableName(userProfile)).toBe("user_profile");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(userProfile);
    expect(cols.id.name).toBe("id");
    expect(cols.name.name).toBe("name");
    expect(cols.email.name).toBe("email");
    expect(cols.birthDate.name).toBe("birth_date");
    expect(cols.maxHr.name).toBe("max_hr");
    expect(cols.restingHr.name).toBe("resting_hr");
    expect(cols.ftp.name).toBe("ftp");
    expect(cols.createdAt.name).toBe("created_at");
    expect(cols.updatedAt.name).toBe("updated_at");
  });
});

describe("provider table", () => {
  it("has correct table name", () => {
    expect(getTableName(provider)).toBe("provider");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(provider);
    expect(cols.id.name).toBe("id");
    expect(cols.name.name).toBe("name");
    expect(cols.apiBaseUrl.name).toBe("api_base_url");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("exercise table", () => {
  it("has correct table name", () => {
    expect(getTableName(exercise)).toBe("exercise");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(exercise);
    expect(cols.id.name).toBe("id");
    expect(cols.name.name).toBe("name");
    expect(cols.muscleGroup.name).toBe("muscle_group");
    expect(cols.equipment.name).toBe("equipment");
    expect(cols.movement.name).toBe("movement");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("exerciseAlias table", () => {
  it("has correct table name", () => {
    expect(getTableName(exerciseAlias)).toBe("exercise_alias");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(exerciseAlias);
    expect(cols.id.name).toBe("id");
    expect(cols.exerciseId.name).toBe("exercise_id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.providerExerciseId.name).toBe("provider_exercise_id");
    expect(cols.providerExerciseName.name).toBe("provider_exercise_name");
  });
});

describe("oauthToken table", () => {
  it("has correct table name", () => {
    expect(getTableName(oauthToken)).toBe("oauth_token");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(oauthToken);
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.accessToken.name).toBe("access_token");
    expect(cols.refreshToken.name).toBe("refresh_token");
    expect(cols.expiresAt.name).toBe("expires_at");
    expect(cols.scopes.name).toBe("scopes");
    expect(cols.createdAt.name).toBe("created_at");
    expect(cols.updatedAt.name).toBe("updated_at");
  });
});

describe("bodyMeasurement table", () => {
  it("has correct table name", () => {
    expect(getTableName(bodyMeasurement)).toBe("body_measurement");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(bodyMeasurement);
    expect(cols.id.name).toBe("id");
    expect(cols.recordedAt.name).toBe("recorded_at");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.weightKg.name).toBe("weight_kg");
    expect(cols.bodyFatPct.name).toBe("body_fat_pct");
    expect(cols.muscleMassKg.name).toBe("muscle_mass_kg");
    expect(cols.boneMassKg.name).toBe("bone_mass_kg");
    expect(cols.waterPct.name).toBe("water_pct");
    expect(cols.bmi.name).toBe("bmi");
    expect(cols.heightCm.name).toBe("height_cm");
    expect(cols.waistCircumferenceCm.name).toBe("waist_circumference_cm");
    expect(cols.systolicBp.name).toBe("systolic_bp");
    expect(cols.diastolicBp.name).toBe("diastolic_bp");
    expect(cols.heartPulse.name).toBe("heart_pulse");
    expect(cols.temperatureC.name).toBe("temperature_c");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("strengthWorkout table", () => {
  it("has correct table name", () => {
    expect(getTableName(strengthWorkout)).toBe("strength_workout");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(strengthWorkout);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.startedAt.name).toBe("started_at");
    expect(cols.endedAt.name).toBe("ended_at");
    expect(cols.name.name).toBe("name");
    expect(cols.notes.name).toBe("notes");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("strengthSet table", () => {
  it("has correct table name", () => {
    expect(getTableName(strengthSet)).toBe("strength_set");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(strengthSet);
    expect(cols.id.name).toBe("id");
    expect(cols.workoutId.name).toBe("workout_id");
    expect(cols.exerciseId.name).toBe("exercise_id");
    expect(cols.exerciseIndex.name).toBe("exercise_index");
    expect(cols.setIndex.name).toBe("set_index");
    expect(cols.setType.name).toBe("set_type");
    expect(cols.weightKg.name).toBe("weight_kg");
    expect(cols.reps.name).toBe("reps");
    expect(cols.distanceMeters.name).toBe("distance_meters");
    expect(cols.durationSeconds.name).toBe("duration_seconds");
    expect(cols.rpe.name).toBe("rpe");
    expect(cols.notes.name).toBe("notes");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("activity table", () => {
  it("has correct table name", () => {
    expect(getTableName(activity)).toBe("activity");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(activity);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.activityType.name).toBe("activity_type");
    expect(cols.startedAt.name).toBe("started_at");
    expect(cols.endedAt.name).toBe("ended_at");
    expect(cols.name.name).toBe("name");
    expect(cols.notes.name).toBe("notes");
    expect(cols.perceivedExertion.name).toBe("perceived_exertion");
    expect(cols.raw.name).toBe("raw");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("sportSettings table", () => {
  it("has correct table name", () => {
    expect(getTableName(sportSettings)).toBe("sport_settings");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(sportSettings);
    expect(cols.id.name).toBe("id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.sport.name).toBe("sport");
    expect(cols.ftp.name).toBe("ftp");
    expect(cols.thresholdHr.name).toBe("threshold_hr");
    expect(cols.thresholdPacePerKm.name).toBe("threshold_pace_per_km");
    expect(cols.powerZonePcts.name).toBe("power_zone_pcts");
    expect(cols.hrZonePcts.name).toBe("hr_zone_pcts");
    expect(cols.paceZonePcts.name).toBe("pace_zone_pcts");
    expect(cols.effectiveFrom.name).toBe("effective_from");
    expect(cols.notes.name).toBe("notes");
    expect(cols.createdAt.name).toBe("created_at");
    expect(cols.updatedAt.name).toBe("updated_at");
  });
});

describe("activityInterval table", () => {
  it("has correct table name", () => {
    expect(getTableName(activityInterval)).toBe("activity_interval");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(activityInterval);
    expect(cols.id.name).toBe("id");
    expect(cols.activityId.name).toBe("activity_id");
    expect(cols.intervalIndex.name).toBe("interval_index");
    expect(cols.label.name).toBe("label");
    expect(cols.intervalType.name).toBe("interval_type");
    expect(cols.startedAt.name).toBe("started_at");
    expect(cols.endedAt.name).toBe("ended_at");
    expect(cols.avgHeartRate.name).toBe("avg_heart_rate");
    expect(cols.maxHeartRate.name).toBe("max_heart_rate");
    expect(cols.avgPower.name).toBe("avg_power");
    expect(cols.maxPower.name).toBe("max_power");
    expect(cols.avgSpeed.name).toBe("avg_speed");
    expect(cols.maxSpeed.name).toBe("max_speed");
    expect(cols.avgCadence.name).toBe("avg_cadence");
    expect(cols.distanceMeters.name).toBe("distance_meters");
    expect(cols.elevationGain.name).toBe("elevation_gain");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("metricStream table", () => {
  it("has correct table name", () => {
    expect(getTableName(metricStream)).toBe("metric_stream");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(metricStream);
    expect(cols.recordedAt.name).toBe("recorded_at");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.activityId.name).toBe("activity_id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.heartRate.name).toBe("heart_rate");
    expect(cols.power.name).toBe("power");
    expect(cols.cadence.name).toBe("cadence");
    expect(cols.speed.name).toBe("speed");
    expect(cols.lat.name).toBe("lat");
    expect(cols.lng.name).toBe("lng");
    expect(cols.altitude.name).toBe("altitude");
    expect(cols.temperature.name).toBe("temperature");
    expect(cols.distance.name).toBe("distance");
    expect(cols.grade.name).toBe("grade");
    expect(cols.calories.name).toBe("calories");
    expect(cols.verticalSpeed.name).toBe("vertical_speed");
    expect(cols.spo2.name).toBe("spo2");
    expect(cols.respiratoryRate.name).toBe("respiratory_rate");
    expect(cols.gpsAccuracy.name).toBe("gps_accuracy");
    expect(cols.accumulatedPower.name).toBe("accumulated_power");
    expect(cols.stress.name).toBe("stress");
    expect(cols.leftRightBalance.name).toBe("left_right_balance");
    expect(cols.verticalOscillation.name).toBe("vertical_oscillation");
    expect(cols.stanceTime.name).toBe("stance_time");
    expect(cols.stanceTimePercent.name).toBe("stance_time_percent");
    expect(cols.stepLength.name).toBe("step_length");
    expect(cols.verticalRatio.name).toBe("vertical_ratio");
    expect(cols.stanceTimeBalance.name).toBe("stance_time_balance");
    expect(cols.groundContactTime.name).toBe("ground_contact_time");
    expect(cols.strideLength.name).toBe("stride_length");
    expect(cols.formPower.name).toBe("form_power");
    expect(cols.legSpringStiff.name).toBe("leg_spring_stiff");
    expect(cols.airPower.name).toBe("air_power");
    expect(cols.leftTorqueEffectiveness.name).toBe("left_torque_effectiveness");
    expect(cols.rightTorqueEffectiveness.name).toBe("right_torque_effectiveness");
    expect(cols.leftPedalSmoothness.name).toBe("left_pedal_smoothness");
    expect(cols.rightPedalSmoothness.name).toBe("right_pedal_smoothness");
    expect(cols.combinedPedalSmoothness.name).toBe("combined_pedal_smoothness");
    expect(cols.bloodGlucose.name).toBe("blood_glucose");
    expect(cols.audioExposure.name).toBe("audio_exposure");
    expect(cols.skinTemperature.name).toBe("skin_temperature");
    expect(cols.raw.name).toBe("raw");
  });
});

describe("dailyMetrics table", () => {
  it("has correct table name", () => {
    expect(getTableName(dailyMetrics)).toBe("daily_metrics");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(dailyMetrics);
    expect(cols.date.name).toBe("date");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.restingHr.name).toBe("resting_hr");
    expect(cols.hrv.name).toBe("hrv");
    expect(cols.vo2max.name).toBe("vo2max");
    expect(cols.spo2Avg.name).toBe("spo2_avg");
    expect(cols.respiratoryRateAvg.name).toBe("respiratory_rate_avg");
    expect(cols.steps.name).toBe("steps");
    expect(cols.activeEnergyKcal.name).toBe("active_energy_kcal");
    expect(cols.basalEnergyKcal.name).toBe("basal_energy_kcal");
    expect(cols.distanceKm.name).toBe("distance_km");
    expect(cols.cyclingDistanceKm.name).toBe("cycling_distance_km");
    expect(cols.flightsClimbed.name).toBe("flights_climbed");
    expect(cols.exerciseMinutes.name).toBe("exercise_minutes");
    expect(cols.mindfulMinutes.name).toBe("mindful_minutes");
    expect(cols.walkingSpeed.name).toBe("walking_speed");
    expect(cols.walkingStepLength.name).toBe("walking_step_length");
    expect(cols.walkingDoubleSupportPct.name).toBe("walking_double_support_pct");
    expect(cols.walkingAsymmetryPct.name).toBe("walking_asymmetry_pct");
    expect(cols.walkingSteadiness.name).toBe("walking_steadiness");
    expect(cols.standHours.name).toBe("stand_hours");
    expect(cols.environmentalAudioExposure.name).toBe("environmental_audio_exposure");
    expect(cols.headphoneAudioExposure.name).toBe("headphone_audio_exposure");
    expect(cols.skinTempC.name).toBe("skin_temp_c");
    expect(cols.stressHighMinutes.name).toBe("stress_high_minutes");
    expect(cols.recoveryHighMinutes.name).toBe("recovery_high_minutes");
    expect(cols.resilienceLevel.name).toBe("resilience_level");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("sleepSession table", () => {
  it("has correct table name", () => {
    expect(getTableName(sleepSession)).toBe("sleep_session");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(sleepSession);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.startedAt.name).toBe("started_at");
    expect(cols.endedAt.name).toBe("ended_at");
    expect(cols.durationMinutes.name).toBe("duration_minutes");
    expect(cols.deepMinutes.name).toBe("deep_minutes");
    expect(cols.remMinutes.name).toBe("rem_minutes");
    expect(cols.lightMinutes.name).toBe("light_minutes");
    expect(cols.awakeMinutes.name).toBe("awake_minutes");
    expect(cols.efficiencyPct.name).toBe("efficiency_pct");
    expect(cols.isNap.name).toBe("is_nap");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("nutritionDaily table", () => {
  it("has correct table name", () => {
    expect(getTableName(nutritionDaily)).toBe("nutrition_daily");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(nutritionDaily);
    expect(cols.date.name).toBe("date");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.calories.name).toBe("calories");
    expect(cols.proteinG.name).toBe("protein_g");
    expect(cols.carbsG.name).toBe("carbs_g");
    expect(cols.fatG.name).toBe("fat_g");
    expect(cols.fiberG.name).toBe("fiber_g");
    expect(cols.waterMl.name).toBe("water_ml");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("foodEntry table", () => {
  it("has correct table name", () => {
    expect(getTableName(foodEntry)).toBe("food_entry");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(foodEntry);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.date.name).toBe("date");
    expect(cols.meal.name).toBe("meal");
    expect(cols.foodName.name).toBe("food_name");
    expect(cols.foodDescription.name).toBe("food_description");
    expect(cols.category.name).toBe("category");
    expect(cols.providerFoodId.name).toBe("provider_food_id");
    expect(cols.providerServingId.name).toBe("provider_serving_id");
    expect(cols.numberOfUnits.name).toBe("number_of_units");
    expect(cols.loggedAt.name).toBe("logged_at");
    expect(cols.barcode.name).toBe("barcode");
    expect(cols.servingUnit.name).toBe("serving_unit");
    expect(cols.servingWeightGrams.name).toBe("serving_weight_grams");
    expect(cols.calories.name).toBe("calories");
    expect(cols.proteinG.name).toBe("protein_g");
    expect(cols.carbsG.name).toBe("carbs_g");
    expect(cols.fatG.name).toBe("fat_g");
    expect(cols.saturatedFatG.name).toBe("saturated_fat_g");
    expect(cols.polyunsaturatedFatG.name).toBe("polyunsaturated_fat_g");
    expect(cols.monounsaturatedFatG.name).toBe("monounsaturated_fat_g");
    expect(cols.transFatG.name).toBe("trans_fat_g");
    expect(cols.cholesterolMg.name).toBe("cholesterol_mg");
    expect(cols.sodiumMg.name).toBe("sodium_mg");
    expect(cols.potassiumMg.name).toBe("potassium_mg");
    expect(cols.fiberG.name).toBe("fiber_g");
    expect(cols.sugarG.name).toBe("sugar_g");
    expect(cols.vitaminAMcg.name).toBe("vitamin_a_mcg");
    expect(cols.vitaminCMg.name).toBe("vitamin_c_mg");
    expect(cols.vitaminDMcg.name).toBe("vitamin_d_mcg");
    expect(cols.vitaminEMg.name).toBe("vitamin_e_mg");
    expect(cols.vitaminKMcg.name).toBe("vitamin_k_mcg");
    expect(cols.vitaminB1Mg.name).toBe("vitamin_b1_mg");
    expect(cols.vitaminB2Mg.name).toBe("vitamin_b2_mg");
    expect(cols.vitaminB3Mg.name).toBe("vitamin_b3_mg");
    expect(cols.vitaminB5Mg.name).toBe("vitamin_b5_mg");
    expect(cols.vitaminB6Mg.name).toBe("vitamin_b6_mg");
    expect(cols.vitaminB7Mcg.name).toBe("vitamin_b7_mcg");
    expect(cols.vitaminB9Mcg.name).toBe("vitamin_b9_mcg");
    expect(cols.vitaminB12Mcg.name).toBe("vitamin_b12_mcg");
    expect(cols.calciumMg.name).toBe("calcium_mg");
    expect(cols.ironMg.name).toBe("iron_mg");
    expect(cols.magnesiumMg.name).toBe("magnesium_mg");
    expect(cols.zincMg.name).toBe("zinc_mg");
    expect(cols.seleniumMcg.name).toBe("selenium_mcg");
    expect(cols.copperMg.name).toBe("copper_mg");
    expect(cols.manganeseMg.name).toBe("manganese_mg");
    expect(cols.chromiumMcg.name).toBe("chromium_mcg");
    expect(cols.iodineMcg.name).toBe("iodine_mcg");
    expect(cols.omega3Mg.name).toBe("omega3_mg");
    expect(cols.omega6Mg.name).toBe("omega6_mg");
    expect(cols.raw.name).toBe("raw");
    expect(cols.confirmed.name).toBe("confirmed");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("labResult table", () => {
  it("has correct table name", () => {
    expect(getTableName(labResult)).toBe("lab_result");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(labResult);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.testName.name).toBe("test_name");
    expect(cols.loincCode.name).toBe("loinc_code");
    expect(cols.value.name).toBe("value");
    expect(cols.valueText.name).toBe("value_text");
    expect(cols.unit.name).toBe("unit");
    expect(cols.referenceRangeLow.name).toBe("reference_range_low");
    expect(cols.referenceRangeHigh.name).toBe("reference_range_high");
    expect(cols.referenceRangeText.name).toBe("reference_range_text");
    expect(cols.panelName.name).toBe("panel_name");
    expect(cols.status.name).toBe("status");
    expect(cols.sourceName.name).toBe("source_name");
    expect(cols.recordedAt.name).toBe("recorded_at");
    expect(cols.issuedAt.name).toBe("issued_at");
    expect(cols.raw.name).toBe("raw");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("healthEvent table", () => {
  it("has correct table name", () => {
    expect(getTableName(healthEvent)).toBe("health_event");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(healthEvent);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.externalId.name).toBe("external_id");
    expect(cols.type.name).toBe("type");
    expect(cols.value.name).toBe("value");
    expect(cols.valueText.name).toBe("value_text");
    expect(cols.unit.name).toBe("unit");
    expect(cols.sourceName.name).toBe("source_name");
    expect(cols.startDate.name).toBe("start_date");
    expect(cols.endDate.name).toBe("end_date");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("authAccount table", () => {
  it("has correct table name", () => {
    expect(getTableName(authAccount)).toBe("auth_account");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(authAccount);
    expect(cols.id.name).toBe("id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.authProvider.name).toBe("auth_provider");
    expect(cols.providerAccountId.name).toBe("provider_account_id");
    expect(cols.email.name).toBe("email");
    expect(cols.name.name).toBe("name");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("slackInstallation table", () => {
  it("has correct table name", () => {
    expect(getTableName(slackInstallation)).toBe("slack_installation");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(slackInstallation);
    expect(cols.id.name).toBe("id");
    expect(cols.teamId.name).toBe("team_id");
    expect(cols.teamName.name).toBe("team_name");
    expect(cols.botToken.name).toBe("bot_token");
    expect(cols.botId.name).toBe("bot_id");
    expect(cols.botUserId.name).toBe("bot_user_id");
    expect(cols.appId.name).toBe("app_id");
    expect(cols.installerSlackUserId.name).toBe("installer_slack_user_id");
    expect(cols.rawInstallation.name).toBe("raw_installation");
    expect(cols.installedAt.name).toBe("installed_at");
    expect(cols.updatedAt.name).toBe("updated_at");
  });
});

describe("session table", () => {
  it("has correct table name", () => {
    expect(getTableName(session)).toBe("session");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(session);
    expect(cols.id.name).toBe("id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.expiresAt.name).toBe("expires_at");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("userSettings table", () => {
  it("has correct table name", () => {
    expect(getTableName(userSettings)).toBe("user_settings");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(userSettings);
    expect(cols.userId.name).toBe("user_id");
    expect(cols.key.name).toBe("key");
    expect(cols.value.name).toBe("value");
    expect(cols.updatedAt.name).toBe("updated_at");
  });
});

describe("syncLog table", () => {
  it("has correct table name", () => {
    expect(getTableName(syncLog)).toBe("sync_log");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(syncLog);
    expect(cols.id.name).toBe("id");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.dataType.name).toBe("data_type");
    expect(cols.status.name).toBe("status");
    expect(cols.recordCount.name).toBe("record_count");
    expect(cols.errorMessage.name).toBe("error_message");
    expect(cols.durationMs.name).toBe("duration_ms");
    expect(cols.syncedAt.name).toBe("synced_at");
  });
});

describe("journalEntry table", () => {
  it("has correct table name", () => {
    expect(getTableName(journalEntry)).toBe("journal_entry");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(journalEntry);
    expect(cols.id.name).toBe("id");
    expect(cols.date.name).toBe("date");
    expect(cols.providerId.name).toBe("provider_id");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.question.name).toBe("question");
    expect(cols.answerText.name).toBe("answer_text");
    expect(cols.answerNumeric.name).toBe("answer_numeric");
    expect(cols.impactScore.name).toBe("impact_score");
    expect(cols.createdAt.name).toBe("created_at");
  });
});

describe("lifeEvents table", () => {
  it("has correct table name", () => {
    expect(getTableName(lifeEvents)).toBe("life_events");
  });

  it("has correct column names", () => {
    const cols = getTableColumns(lifeEvents);
    expect(cols.id.name).toBe("id");
    expect(cols.label.name).toBe("label");
    expect(cols.userId.name).toBe("user_id");
    expect(cols.startedAt.name).toBe("started_at");
    expect(cols.endedAt.name).toBe("ended_at");
    expect(cols.category.name).toBe("category");
    expect(cols.ongoing.name).toBe("ongoing");
    expect(cols.notes.name).toBe("notes");
    expect(cols.createdAt.name).toBe("created_at");
  });
});
