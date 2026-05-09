import { describe, expect, it } from "vitest";

describe("DRIZZLE_FIELD_TO_CHANNEL", () => {
  it("maps every Drizzle metric field to the canonical metric_stream channel", async () => {
    const { DRIZZLE_FIELD_TO_CHANNEL } = await import("./sensor-channels.ts");

    expect(DRIZZLE_FIELD_TO_CHANNEL).toEqual({
      accumulatedPower: "accumulated_power",
      airPower: "air_power",
      altitude: "altitude",
      audioExposure: "audio_exposure",
      bloodGlucose: "blood_glucose",
      cadence: "cadence",
      combinedPedalSmoothness: "combined_pedal_smoothness",
      electrodermalActivity: "electrodermal_activity",
      formPower: "form_power",
      grade: "grade",
      groundContactTime: "ground_contact_time",
      heartRate: "heart_rate",
      leftPedalSmoothness: "left_pedal_smoothness",
      leftRightBalance: "left_right_balance",
      leftTorqueEffectiveness: "left_torque_effectiveness",
      legSpringStiff: "leg_spring_stiff",
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
      temperature: "temperature",
      verticalOscillation: "vertical_oscillation",
      verticalRatio: "vertical_ratio",
      verticalSpeed: "vertical_speed",
    });
  });
});
