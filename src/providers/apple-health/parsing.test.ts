import { describe, expect, it } from "vitest";
import {
  enrichWorkoutFromStats,
  type HealthWorkout,
  parseActivitySummary,
  parseCategoryRecord,
  parseHealthDate,
  parseRecord,
  parseRouteLocation,
  parseSleepAnalysis,
  parseWorkout,
  parseWorkoutStatistics,
} from "./index.ts";

// ============================================================
// Pure parsing unit tests -- Apple Health XML element attributes
// ============================================================

// Record elements come as attribute maps from the SAX parser
const heartRateAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierHeartRate",
  sourceName: "Apple Watch",
  unit: "count/min",
  creationDate: "2024-03-01 10:30:00 -0500",
  startDate: "2024-03-01 10:30:00 -0500",
  endDate: "2024-03-01 10:30:05 -0500",
  value: "72",
};

const bodyMassAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierBodyMass",
  sourceName: "Withings",
  unit: "kg",
  creationDate: "2024-03-01 08:00:00 -0500",
  startDate: "2024-03-01 08:00:00 -0500",
  endDate: "2024-03-01 08:00:00 -0500",
  value: "72.5",
};

const bodyFatAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierBodyFatPercentage",
  sourceName: "Withings",
  unit: "%",
  creationDate: "2024-03-01 08:00:00 -0500",
  startDate: "2024-03-01 08:00:00 -0500",
  endDate: "2024-03-01 08:00:00 -0500",
  value: "0.215",
};

const restingHrAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierRestingHeartRate",
  sourceName: "Apple Watch",
  unit: "count/min",
  creationDate: "2024-03-01 00:00:00 -0500",
  startDate: "2024-03-01 00:00:00 -0500",
  endDate: "2024-03-01 00:00:00 -0500",
  value: "52",
};

const hrvAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  sourceName: "Apple Watch",
  unit: "ms",
  creationDate: "2024-03-01 07:00:00 -0500",
  startDate: "2024-03-01 07:00:00 -0500",
  endDate: "2024-03-01 07:00:00 -0500",
  value: "45.3",
};

const vo2maxAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierVO2Max",
  sourceName: "Apple Watch",
  unit: "mL/min\u00b7kg",
  creationDate: "2024-03-01 12:00:00 -0500",
  startDate: "2024-03-01 12:00:00 -0500",
  endDate: "2024-03-01 12:00:00 -0500",
  value: "48.2",
};

const oxygenSatAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierOxygenSaturation",
  sourceName: "Apple Watch",
  unit: "%",
  creationDate: "2024-03-01 03:00:00 -0500",
  startDate: "2024-03-01 03:00:00 -0500",
  endDate: "2024-03-01 03:00:05 -0500",
  value: "0.97",
};

const stepCountAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierStepCount",
  sourceName: "iPhone",
  unit: "count",
  creationDate: "2024-03-01 14:00:00 -0500",
  startDate: "2024-03-01 14:00:00 -0500",
  endDate: "2024-03-01 14:15:00 -0500",
  value: "1250",
};

const activeEnergyAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierActiveEnergyBurned",
  sourceName: "Apple Watch",
  unit: "kcal",
  creationDate: "2024-03-01 14:00:00 -0500",
  startDate: "2024-03-01 14:00:00 -0500",
  endDate: "2024-03-01 14:30:00 -0500",
  value: "85.3",
};

const respiratoryRateAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierRespiratoryRate",
  sourceName: "Apple Watch",
  unit: "count/min",
  creationDate: "2024-03-01 03:00:00 -0500",
  startDate: "2024-03-01 03:00:00 -0500",
  endDate: "2024-03-01 03:00:00 -0500",
  value: "14.5",
};

const bloodPressureSysAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierBloodPressureSystolic",
  sourceName: "Withings",
  unit: "mmHg",
  creationDate: "2024-03-01 09:00:00 -0500",
  startDate: "2024-03-01 09:00:00 -0500",
  endDate: "2024-03-01 09:00:00 -0500",
  value: "118",
};

const bloodPressureDiaAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierBloodPressureDiastolic",
  sourceName: "Withings",
  unit: "mmHg",
  creationDate: "2024-03-01 09:00:00 -0500",
  startDate: "2024-03-01 09:00:00 -0500",
  endDate: "2024-03-01 09:00:00 -0500",
  value: "78",
};

const bodyTempAttrs: Record<string, string> = {
  type: "HKQuantityTypeIdentifierBodyTemperature",
  sourceName: "Withings",
  unit: "degC",
  creationDate: "2024-03-01 09:30:00 -0500",
  startDate: "2024-03-01 09:30:00 -0500",
  endDate: "2024-03-01 09:30:00 -0500",
  value: "36.8",
};

// Sleep analysis -- newer iOS uses named values
const sleepAsleepCoreAttrs: Record<string, string> = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  creationDate: "2024-03-01 23:30:00 -0500",
  startDate: "2024-03-01 23:30:00 -0500",
  endDate: "2024-03-02 00:45:00 -0500",
  value: "HKCategoryValueSleepAnalysisAsleepCore",
};

const sleepAsleepDeepAttrs: Record<string, string> = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  creationDate: "2024-03-02 00:45:00 -0500",
  startDate: "2024-03-02 00:45:00 -0500",
  endDate: "2024-03-02 01:30:00 -0500",
  value: "HKCategoryValueSleepAnalysisAsleepDeep",
};

const sleepAsleepRemAttrs: Record<string, string> = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  creationDate: "2024-03-02 01:30:00 -0500",
  startDate: "2024-03-02 01:30:00 -0500",
  endDate: "2024-03-02 02:00:00 -0500",
  value: "HKCategoryValueSleepAnalysisAsleepREM",
};

const sleepAwakeAttrs: Record<string, string> = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  creationDate: "2024-03-02 02:00:00 -0500",
  startDate: "2024-03-02 02:00:00 -0500",
  endDate: "2024-03-02 02:05:00 -0500",
  value: "HKCategoryValueSleepAnalysisAwake",
};

const sleepInBedAttrs: Record<string, string> = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  creationDate: "2024-03-01 23:00:00 -0500",
  startDate: "2024-03-01 23:00:00 -0500",
  endDate: "2024-03-02 07:00:00 -0500",
  value: "HKCategoryValueSleepAnalysisInBed",
};

// Workout element attributes
const workoutAttrs: Record<string, string> = {
  workoutActivityType: "HKWorkoutActivityTypeRunning",
  duration: "30.5",
  durationUnit: "min",
  totalDistance: "5200",
  totalDistanceUnit: "m",
  totalEnergyBurned: "320.5",
  totalEnergyBurnedUnit: "kcal",
  sourceName: "Apple Watch",
  sourceVersion: "11.0",
  creationDate: "2024-03-01 18:30:00 -0500",
  startDate: "2024-03-01 18:00:00 -0500",
  endDate: "2024-03-01 18:30:30 -0500",
};

describe("Apple Health Provider -- parsing", () => {
  describe("parseRecord", () => {
    it("parses heart rate records", () => {
      const result = parseRecord(heartRateAttrs);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("HKQuantityTypeIdentifierHeartRate");
      expect(result?.value).toBe(72);
      expect(result?.unit).toBe("count/min");
      expect(result?.sourceName).toBe("Apple Watch");
      expect(result?.startDate).toBeInstanceOf(Date);
      expect(result?.endDate).toBeInstanceOf(Date);
    });

    it("parses body mass records", () => {
      const result = parseRecord(bodyMassAttrs);
      expect(result?.type).toBe("HKQuantityTypeIdentifierBodyMass");
      expect(result?.value).toBe(72.5);
      expect(result?.unit).toBe("kg");
    });

    it("parses body fat percentage (0-1 scale)", () => {
      const result = parseRecord(bodyFatAttrs);
      expect(result?.value).toBe(0.215);
    });

    it("parses resting heart rate", () => {
      const result = parseRecord(restingHrAttrs);
      expect(result?.value).toBe(52);
    });

    it("parses HRV", () => {
      const result = parseRecord(hrvAttrs);
      expect(result?.value).toBeCloseTo(45.3);
    });

    it("parses VO2 max", () => {
      const result = parseRecord(vo2maxAttrs);
      expect(result?.value).toBeCloseTo(48.2);
    });

    it("parses oxygen saturation", () => {
      const result = parseRecord(oxygenSatAttrs);
      expect(result?.value).toBe(0.97);
    });

    it("parses step count", () => {
      const result = parseRecord(stepCountAttrs);
      expect(result?.value).toBe(1250);
    });

    it("parses active energy burned", () => {
      const result = parseRecord(activeEnergyAttrs);
      expect(result?.value).toBeCloseTo(85.3);
    });

    it("parses respiratory rate", () => {
      const result = parseRecord(respiratoryRateAttrs);
      expect(result?.value).toBeCloseTo(14.5);
    });

    it("parses blood pressure systolic", () => {
      const result = parseRecord(bloodPressureSysAttrs);
      expect(result?.value).toBe(118);
    });

    it("parses blood pressure diastolic", () => {
      const result = parseRecord(bloodPressureDiaAttrs);
      expect(result?.value).toBe(78);
    });

    it("parses body temperature", () => {
      const result = parseRecord(bodyTempAttrs);
      expect(result?.value).toBeCloseTo(36.8);
    });

    it("parses Apple Health date format with timezone", () => {
      const result = parseRecord(heartRateAttrs);
      // "2024-03-01 10:30:00 -0500" should parse correctly
      expect(result?.startDate.getTime()).not.toBeNaN();
    });
  });

  describe("parseSleepAnalysis", () => {
    it("parses core sleep stage", () => {
      const result = parseSleepAnalysis(sleepAsleepCoreAttrs);
      expect(result?.stage).toBe("core");
      expect(result?.startDate).toBeInstanceOf(Date);
      expect(result?.endDate).toBeInstanceOf(Date);
    });

    it("parses deep sleep stage", () => {
      const result = parseSleepAnalysis(sleepAsleepDeepAttrs);
      expect(result?.stage).toBe("deep");
    });

    it("parses REM sleep stage", () => {
      const result = parseSleepAnalysis(sleepAsleepRemAttrs);
      expect(result?.stage).toBe("rem");
    });

    it("parses awake stage", () => {
      const result = parseSleepAnalysis(sleepAwakeAttrs);
      expect(result?.stage).toBe("awake");
    });

    it("parses in-bed stage", () => {
      const result = parseSleepAnalysis(sleepInBedAttrs);
      expect(result?.stage).toBe("inBed");
    });

    it("computes duration in minutes", () => {
      const result = parseSleepAnalysis(sleepAsleepCoreAttrs);
      // 23:30 to 00:45 = 75 minutes
      expect(result?.durationMinutes).toBe(75);
    });
  });

  describe("parseWorkout", () => {
    it("parses workout attributes", () => {
      const result = parseWorkout(workoutAttrs);
      expect(result.activityType).toBe("running");
      expect(result.durationSeconds).toBeCloseTo(1830); // 30.5 min
      expect(result.distanceMeters).toBe(5200);
      expect(result.calories).toBe(321); // rounded
      expect(result.sourceName).toBe("Apple Watch");
      expect(result.startDate).toBeInstanceOf(Date);
      expect(result.endDate).toBeInstanceOf(Date);
    });

    it("maps workout activity types to normalized names", () => {
      const running = parseWorkout({
        ...workoutAttrs,
        workoutActivityType: "HKWorkoutActivityTypeRunning",
      });
      expect(running.activityType).toBe("running");

      const cycling = parseWorkout({
        ...workoutAttrs,
        workoutActivityType: "HKWorkoutActivityTypeCycling",
      });
      expect(cycling.activityType).toBe("cycling");

      const swimming = parseWorkout({
        ...workoutAttrs,
        workoutActivityType: "HKWorkoutActivityTypeSwimming",
      });
      expect(swimming.activityType).toBe("swimming");

      const hiking = parseWorkout({
        ...workoutAttrs,
        workoutActivityType: "HKWorkoutActivityTypeHiking",
      });
      expect(hiking.activityType).toBe("hiking");
    });

    it("handles missing optional fields", () => {
      const minimal: Record<string, string> = {
        workoutActivityType: "HKWorkoutActivityTypeRunning",
        duration: "10",
        durationUnit: "min",
        sourceName: "Apple Watch",
        creationDate: "2024-03-01 18:00:00 -0500",
        startDate: "2024-03-01 18:00:00 -0500",
        endDate: "2024-03-01 18:10:00 -0500",
      };
      const result = parseWorkout(minimal);
      expect(result.activityType).toBe("running");
      expect(result.distanceMeters).toBeUndefined();
      expect(result.calories).toBeUndefined();
    });
  });

  describe("parseActivitySummary", () => {
    it("parses daily activity ring data", () => {
      const attrs: Record<string, string> = {
        dateComponents: "2024-03-01",
        activeEnergyBurned: "523.4",
        activeEnergyBurnedGoal: "600",
        activeEnergyBurnedUnit: "kcal",
        appleExerciseTime: "45",
        appleExerciseTimeGoal: "30",
        appleStandHours: "12",
        appleStandHoursGoal: "12",
      };
      const result = parseActivitySummary(attrs);
      expect(result).not.toBeNull();
      expect(result?.date).toBe("2024-03-01");
      expect(result?.activeEnergyBurned).toBeCloseTo(523.4);
      expect(result?.appleExerciseMinutes).toBe(45);
      expect(result?.appleStandHours).toBe(12);
    });

    it("returns null without dateComponents", () => {
      const result = parseActivitySummary({});
      expect(result).toBeNull();
    });

    it("handles missing optional fields", () => {
      const result = parseActivitySummary({ dateComponents: "2024-03-01" });
      expect(result?.activeEnergyBurned).toBeUndefined();
      expect(result?.appleExerciseMinutes).toBeUndefined();
    });
  });

  describe("WorkoutStatistics", () => {
    it("parses statistics attributes", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierHeartRate",
        startDate: "2024-03-01 18:00:00 -0500",
        endDate: "2024-03-01 18:30:00 -0500",
        average: "145",
        minimum: "120",
        maximum: "175",
        unit: "count/min",
      };
      const result = parseWorkoutStatistics(attrs);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("HKQuantityTypeIdentifierHeartRate");
      expect(result?.average).toBe(145);
      expect(result?.minimum).toBe(120);
      expect(result?.maximum).toBe(175);
    });

    it("enriches workout with HR stats", () => {
      const workout = parseWorkout(workoutAttrs);
      expect(workout.avgHeartRate).toBeUndefined();

      enrichWorkoutFromStats(workout, [
        {
          type: "HKQuantityTypeIdentifierHeartRate",
          average: 148.5,
          minimum: 115,
          maximum: 182,
          unit: "count/min",
        },
      ]);

      expect(workout.avgHeartRate).toBe(149); // rounded
      expect(workout.maxHeartRate).toBe(182);
    });

    it("enriches workout calories from ActiveEnergyBurned", () => {
      const minimal: Record<string, string> = {
        workoutActivityType: "HKWorkoutActivityTypeRunning",
        duration: "30",
        durationUnit: "min",
        sourceName: "Apple Watch",
        creationDate: "2024-03-01 18:00:00 -0500",
        startDate: "2024-03-01 18:00:00 -0500",
        endDate: "2024-03-01 18:30:00 -0500",
      };
      const workout = parseWorkout(minimal);
      expect(workout.calories).toBeUndefined();

      enrichWorkoutFromStats(workout, [
        {
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          sum: 312.7,
          unit: "kcal",
        },
      ]);

      expect(workout.calories).toBe(313);
    });

    it("does not overwrite existing calories from workout attributes", () => {
      const workout = parseWorkout(workoutAttrs);
      const originalCalories = workout.calories;

      enrichWorkoutFromStats(workout, [
        {
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          sum: 999,
          unit: "kcal",
        },
      ]);

      expect(workout.calories).toBe(originalCalories);
    });
  });

  describe("parseRouteLocation", () => {
    const locationAttrs: Record<string, string> = {
      date: "2024-03-01 18:05:00 -0500",
      latitude: "40.712800",
      longitude: "-74.006000",
      altitude: "10.500",
      horizontalAccuracy: "5.000",
      verticalAccuracy: "3.000",
      course: "180.500",
      speed: "3.500",
    };

    it("parses all Location attributes", () => {
      const result = parseRouteLocation(locationAttrs);
      expect(result).not.toBeNull();
      expect(result?.date).toBeInstanceOf(Date);
      expect(result?.lat).toBeCloseTo(40.7128);
      expect(result?.lng).toBeCloseTo(-74.006);
      expect(result?.altitude).toBeCloseTo(10.5);
      expect(result?.horizontalAccuracy).toBeCloseTo(5.0);
      expect(result?.verticalAccuracy).toBeCloseTo(3.0);
      expect(result?.course).toBeCloseTo(180.5);
      expect(result?.speed).toBeCloseTo(3.5);
    });

    it("returns null without lat/lng", () => {
      const noLat = { ...locationAttrs };
      delete noLat.latitude;
      expect(parseRouteLocation(noLat)).toBeNull();

      const noLng = { ...locationAttrs };
      delete noLng.longitude;
      expect(parseRouteLocation(noLng)).toBeNull();
    });

    it("handles missing optional fields", () => {
      const minimal: Record<string, string> = {
        date: "2024-03-01 18:05:00 -0500",
        latitude: "40.7128",
        longitude: "-74.006",
      };
      const result = parseRouteLocation(minimal);
      expect(result).not.toBeNull();
      expect(result?.altitude).toBeUndefined();
      expect(result?.speed).toBeUndefined();
      expect(result?.course).toBeUndefined();
    });
  });

  describe("parseRecord -- new types", () => {
    it("parses blood glucose", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierBloodGlucose",
        sourceName: "Dexcom G7",
        unit: "mmol/L",
        value: "5.4",
        creationDate: "2024-03-01 10:00:00 -0500",
        startDate: "2024-03-01 10:00:00 -0500",
        endDate: "2024-03-01 10:00:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.type).toBe("HKQuantityTypeIdentifierBloodGlucose");
      expect(result?.value).toBeCloseTo(5.4);
    });

    it("parses dietary energy consumed", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        sourceName: "MyFitnessPal",
        unit: "kcal",
        value: "2100",
        creationDate: "2024-03-01 20:00:00 -0500",
        startDate: "2024-03-01 20:00:00 -0500",
        endDate: "2024-03-01 20:00:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBe(2100);
    });

    it("parses dietary protein", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierDietaryProtein",
        sourceName: "MyFitnessPal",
        unit: "g",
        value: "145.5",
        creationDate: "2024-03-01 20:00:00 -0500",
        startDate: "2024-03-01 20:00:00 -0500",
        endDate: "2024-03-01 20:00:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBeCloseTo(145.5);
    });

    it("parses walking/running distance", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        sourceName: "iPhone",
        unit: "m",
        value: "523.7",
        creationDate: "2024-03-01 14:00:00 -0500",
        startDate: "2024-03-01 14:00:00 -0500",
        endDate: "2024-03-01 14:15:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBeCloseTo(523.7);
    });

    it("parses flights climbed", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierFlightsClimbed",
        sourceName: "iPhone",
        unit: "count",
        value: "3",
        creationDate: "2024-03-01 14:00:00 -0500",
        startDate: "2024-03-01 14:00:00 -0500",
        endDate: "2024-03-01 14:15:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBe(3);
    });

    it("parses environmental audio exposure", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
        sourceName: "Apple Watch",
        unit: "dBASPL",
        value: "72.5",
        creationDate: "2024-03-01 14:00:00 -0500",
        startDate: "2024-03-01 14:00:00 -0500",
        endDate: "2024-03-01 14:30:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBeCloseTo(72.5);
    });

    it("parses height", () => {
      const attrs: Record<string, string> = {
        type: "HKQuantityTypeIdentifierHeight",
        sourceName: "Health",
        unit: "cm",
        value: "180.3",
        creationDate: "2024-03-01 08:00:00 -0500",
        startDate: "2024-03-01 08:00:00 -0500",
        endDate: "2024-03-01 08:00:00 -0500",
      };
      const result = parseRecord(attrs);
      expect(result?.value).toBeCloseTo(180.3);
    });
  });

  describe("parseCategoryRecord", () => {
    it("parses mindful session", () => {
      const attrs: Record<string, string> = {
        type: "HKCategoryTypeIdentifierMindfulSession",
        sourceName: "Headspace",
        value: "1",
        creationDate: "2024-03-01 07:00:00 -0500",
        startDate: "2024-03-01 07:00:00 -0500",
        endDate: "2024-03-01 07:15:00 -0500",
      };
      const result = parseCategoryRecord(attrs);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("HKCategoryTypeIdentifierMindfulSession");
      expect(result?.value).toBe("1");
      expect(result?.sourceName).toBe("Headspace");
      expect(result?.startDate).toBeInstanceOf(Date);
      expect(result?.endDate).toBeInstanceOf(Date);
    });

    it("parses menstrual flow", () => {
      const attrs: Record<string, string> = {
        type: "HKCategoryTypeIdentifierMenstrualFlow",
        sourceName: "Apple Health",
        value: "HKCategoryValueMenstrualFlowLight",
        creationDate: "2024-03-01 08:00:00 -0500",
        startDate: "2024-03-01 08:00:00 -0500",
        endDate: "2024-03-01 08:00:00 -0500",
      };
      const result = parseCategoryRecord(attrs);
      expect(result?.type).toBe("HKCategoryTypeIdentifierMenstrualFlow");
      expect(result?.value).toBe("HKCategoryValueMenstrualFlowLight");
    });

    it("returns null without type", () => {
      const result = parseCategoryRecord({ value: "1" });
      expect(result).toBeNull();
    });

    it("handles missing value", () => {
      const result = parseCategoryRecord({
        type: "HKCategoryTypeIdentifierMindfulSession",
        sourceName: "Headspace",
        startDate: "2024-03-01 07:00:00 -0500",
        endDate: "2024-03-01 07:15:00 -0500",
      });
      expect(result).not.toBeNull();
      expect(result?.value).toBeNull();
    });

    it("handles missing sourceName", () => {
      const result = parseCategoryRecord({
        type: "HKCategoryTypeIdentifierMindfulSession",
        value: "1",
        startDate: "2024-03-01 07:00:00 -0500",
        endDate: "2024-03-01 07:15:00 -0500",
      });
      expect(result).not.toBeNull();
      expect(result?.sourceName).toBeNull();
    });
  });
});

// ============================================================
// Tests merged from apple-health-coverage.test.ts
// ============================================================

describe("parseHealthDate -- edge cases", () => {
  it("parses standard Apple Health format", () => {
    const date = parseHealthDate("2024-03-01 10:30:00 -0500");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("falls back to Date constructor for non-standard format", () => {
    const date = parseHealthDate("2024-03-01T10:30:00Z");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("handles positive timezone offset", () => {
    const date = parseHealthDate("2024-03-01 10:30:00 +0530");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("handles empty string gracefully", () => {
    const date = parseHealthDate("");
    expect(date).toBeInstanceOf(Date);
  });
});

describe("parseRecord -- edge cases", () => {
  it("returns null when type is missing", () => {
    const result = parseRecord({
      value: "72",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is NaN", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: "not-a-number",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is missing", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("handles missing sourceName and unit", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: "72",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).not.toBeNull();
    expect(result?.sourceName).toBeNull();
    expect(result?.unit).toBeNull();
  });
});

describe("parseSleepAnalysis -- legacy numeric values", () => {
  it("parses legacy '0' as inBed", () => {
    const result = parseSleepAnalysis({
      value: "0",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("inBed");
  });

  it("parses legacy '1' as asleep", () => {
    const result = parseSleepAnalysis({
      value: "1",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("asleep");
  });

  it("parses legacy '2' as awake", () => {
    const result = parseSleepAnalysis({
      value: "2",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 02:05:00 -0500",
    });
    expect(result?.stage).toBe("awake");
  });

  it("returns null for unknown sleep stage value", () => {
    const result = parseSleepAnalysis({
      value: "UnknownSleepStage",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is missing", () => {
    const result = parseSleepAnalysis({
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("parses AsleepUnspecified", () => {
    const result = parseSleepAnalysis({
      value: "HKCategoryValueSleepAnalysisAsleepUnspecified",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("asleep");
  });
});

describe("parseWorkout -- distance and duration unit conversions", () => {
  it("converts distance in km to meters", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "10",
      totalDistanceUnit: "km",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBeCloseTo(10000);
  });

  it("converts distance in miles to meters", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "1",
      totalDistanceUnit: "mi",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBeCloseTo(1609.344);
  });

  it("assumes meters for unknown distance unit", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "5000",
      totalDistanceUnit: "m",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBe(5000);
  });

  it("converts duration in hours to seconds", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeCycling",
      duration: "1.5",
      durationUnit: "hr",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 19:30:00 -0500",
    });
    expect(result.durationSeconds).toBeCloseTo(5400);
  });

  it("assumes seconds for unknown duration unit", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "1800",
      durationUnit: "sec",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.durationSeconds).toBe(1800);
  });

  it("handles unknown workout activity type by stripping prefix", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeFutureNewSport",
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("other");
  });

  it("defaults to 'other' for HKWorkoutActivityTypeOther", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeOther",
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("other");
  });

  it("defaults to 'other' when workoutActivityType is missing", () => {
    const result = parseWorkout({
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("other");
  });
});

describe("parseWorkoutStatistics -- edge cases", () => {
  it("returns null when type is missing", () => {
    const result = parseWorkoutStatistics({
      average: "145",
      unit: "count/min",
    });
    expect(result).toBeNull();
  });

  it("handles stats with only sum", () => {
    const result = parseWorkoutStatistics({
      type: "HKQuantityTypeIdentifierActiveEnergyBurned",
      sum: "320",
      unit: "kcal",
    });
    expect(result).not.toBeNull();
    expect(result?.sum).toBe(320);
    expect(result?.average).toBeUndefined();
    expect(result?.minimum).toBeUndefined();
    expect(result?.maximum).toBeUndefined();
  });
});

describe("enrichWorkoutFromStats -- edge cases", () => {
  it("does not modify workout for unrecognized stat types", () => {
    const workout: HealthWorkout = {
      activityType: "running",
      sourceName: "Apple Watch",
      durationSeconds: 1800,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T18:30:00Z"),
    };

    enrichWorkoutFromStats(workout, [
      {
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        sum: 5000,
        unit: "m",
      },
    ]);

    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.maxHeartRate).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });

  it("handles empty stats array", () => {
    const workout: HealthWorkout = {
      activityType: "running",
      sourceName: "Apple Watch",
      durationSeconds: 1800,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T18:30:00Z"),
    };

    enrichWorkoutFromStats(workout, []);

    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.maxHeartRate).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });
});

describe("parseActivitySummary -- additional edge cases", () => {
  it("handles zero values", () => {
    const result = parseActivitySummary({
      dateComponents: "2024-03-01",
      activeEnergyBurned: "0",
      appleExerciseTime: "0",
      appleStandHours: "0",
    });
    expect(result).not.toBeNull();
    expect(result?.activeEnergyBurned).toBe(0);
    expect(result?.appleExerciseMinutes).toBe(0);
    expect(result?.appleStandHours).toBe(0);
  });
});

describe("parseRouteLocation -- NaN coordinates", () => {
  it("returns null for NaN latitude", () => {
    const result = parseRouteLocation({
      date: "2024-03-01 18:00:00 -0500",
      latitude: "NaN",
      longitude: "-74.006",
    });
    expect(result).toBeNull();
  });

  it("returns null for NaN longitude", () => {
    const result = parseRouteLocation({
      date: "2024-03-01 18:00:00 -0500",
      latitude: "40.7128",
      longitude: "NaN",
    });
    expect(result).toBeNull();
  });
});
