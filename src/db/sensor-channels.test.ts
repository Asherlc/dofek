import { describe, expect, it } from "vitest";

describe("sensor channel mappings", () => {
  it("maps every known source field to the canonical metric stream channel", async () => {
    const { BODY_MEASUREMENT_COLUMN_TO_CHANNEL, DRIZZLE_FIELD_TO_CHANNEL } = await import(
      "./sensor-channels.ts"
    );

    expect(DRIZZLE_FIELD_TO_CHANNEL).toEqual({
      accumulatedPower: "accumulated_power",
      airPower: "air_power",
      altitude: "altitude",
      audioExposure: "audio_exposure",
      bloodGlucose: "blood_glucose",
      bmi: "body_mass_index",
      bodyFatPct: "body_fat_percentage",
      boneMassKg: "bone_mass",
      cadence: "cadence",
      combinedPedalSmoothness: "combined_pedal_smoothness",
      diastolicBp: "diastolic_blood_pressure",
      electrodermalActivity: "electrodermal_activity",
      formPower: "form_power",
      grade: "grade",
      groundContactTime: "ground_contact_time",
      heartPulse: "heart_pulse",
      heartRate: "heart_rate",
      heightCm: "height",
      leftPedalSmoothness: "left_pedal_smoothness",
      leftRightBalance: "left_right_balance",
      leftTorqueEffectiveness: "left_torque_effectiveness",
      legSpringStiff: "leg_spring_stiff",
      muscleMassKg: "muscle_mass",
      power: "power",
      respiratoryRate: "respiratory_rate",
      rightPedalSmoothness: "right_pedal_smoothness",
      rightTorqueEffectiveness: "right_torque_effectiveness",
      skinTemperature: "skin_temperature",
      speed: "speed",
      spo2: "spo2",
      stanceTime: "stance_time",
      stanceTimeBalance: "stance_time_balance",
      stanceTimePercent: "stance_time_percent",
      stepLength: "step_length",
      stress: "stress",
      strideLength: "stride_length",
      systolicBp: "systolic_blood_pressure",
      temperature: "temperature",
      temperatureC: "body_temperature",
      verticalOscillation: "vertical_oscillation",
      verticalRatio: "vertical_ratio",
      verticalSpeed: "vertical_speed",
      waistCircumferenceCm: "waist_circumference",
      waterPct: "body_water_percentage",
      weightKg: "body_weight",
    });

    expect(BODY_MEASUREMENT_COLUMN_TO_CHANNEL).toEqual({
      bmi: "body_mass_index",
      body_fat_pct: "body_fat_percentage",
      bone_mass_kg: "bone_mass",
      diastolic_bp: "diastolic_blood_pressure",
      heart_pulse: "heart_pulse",
      height_cm: "height",
      muscle_mass_kg: "muscle_mass",
      systolic_bp: "systolic_blood_pressure",
      temperature_c: "body_temperature",
      waist_circumference_cm: "waist_circumference",
      water_pct: "body_water_percentage",
      weight_kg: "body_weight",
    });
  });
});
