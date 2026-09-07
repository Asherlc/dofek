import type { HealthDataPayload } from "./health-collector.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Watch health summary is invalid.");
  }
  return value;
}

function numberSeries(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("Watch health summary is invalid.");
  return value.map(finiteNumber);
}

export function parseWatchHealthSummary(value: unknown): HealthDataPayload {
  if (
    !isRecord(value) ||
    typeof value.date !== "string" ||
    !value.date.trim() ||
    value.activities !== undefined
  ) {
    throw new Error("Watch health summary is invalid.");
  }
  const heartRateSummary = value.heartRateSummary;
  if (heartRateSummary !== undefined && !isRecord(heartRateSummary)) {
    throw new Error("Watch health summary is invalid.");
  }
  const sleep = value.sleep;
  if (sleep !== undefined && !isRecord(sleep)) throw new Error("Watch health summary is invalid.");
  return {
    collectedAt: finiteNumber(value.collectedAt),
    date: value.date,
    timezoneOffsetMinutes: finiteNumber(value.timezoneOffsetMinutes),
    ...(value.steps === undefined ? {} : { steps: finiteNumber(value.steps) }),
    ...(value.stepsTarget === undefined ? {} : { stepsTarget: finiteNumber(value.stepsTarget) }),
    ...(value.distance === undefined ? {} : { distance: finiteNumber(value.distance) }),
    ...(value.heartRate === undefined ? {} : { heartRate: numberSeries(value.heartRate) }),
    ...(value.restingHeartRate === undefined
      ? {}
      : { restingHeartRate: finiteNumber(value.restingHeartRate) }),
    ...(heartRateSummary === undefined
      ? {}
      : {
          heartRateSummary: {
            ...(heartRateSummary.maxHr === undefined
              ? {}
              : { maxHr: finiteNumber(heartRateSummary.maxHr) }),
            ...(heartRateSummary.maxHrTime === undefined
              ? {}
              : { maxHrTime: finiteNumber(heartRateSummary.maxHrTime) }),
          },
        }),
    ...(sleep === undefined
      ? {}
      : {
          sleep: {
            score: finiteNumber(sleep.score),
            deepMinutes: finiteNumber(sleep.deepMinutes),
            startTime: finiteNumber(sleep.startTime),
            endTime: finiteNumber(sleep.endTime),
            totalTime: finiteNumber(sleep.totalTime),
            ...(sleep.stages === undefined
              ? {}
              : {
                  stages: Array.isArray(sleep.stages)
                    ? sleep.stages.map((stage) => {
                        if (!isRecord(stage)) throw new Error("Watch health summary is invalid.");
                        return {
                          model: finiteNumber(stage.model),
                          start: finiteNumber(stage.start),
                          stop: finiteNumber(stage.stop),
                        };
                      })
                    : (() => {
                        throw new Error("Watch health summary is invalid.");
                      })(),
                }),
          },
        }),
    ...(value.nap === undefined
      ? {}
      : {
          nap: Array.isArray(value.nap)
            ? value.nap.map((nap) => {
                if (!isRecord(nap)) throw new Error("Watch health summary is invalid.");
                return {
                  length: finiteNumber(nap.length),
                  start: finiteNumber(nap.start),
                  stop: finiteNumber(nap.stop),
                };
              })
            : (() => {
                throw new Error("Watch health summary is invalid.");
              })(),
        }),
    ...(value.bloodOxygenCurrent === undefined
      ? {}
      : { bloodOxygenCurrent: finiteNumber(value.bloodOxygenCurrent) }),
    ...(value.bloodOxygenHourly === undefined
      ? {}
      : { bloodOxygenHourly: numberSeries(value.bloodOxygenHourly) }),
    ...(value.spo2Recent === undefined
      ? {}
      : {
          spo2Recent: Array.isArray(value.spo2Recent)
            ? value.spo2Recent.map((reading) => {
                if (!isRecord(reading)) throw new Error("Watch health summary is invalid.");
                return { spo2: finiteNumber(reading.spo2), time: finiteNumber(reading.time) };
              })
            : (() => {
                throw new Error("Watch health summary is invalid.");
              })(),
        }),
    ...(value.bodyTemperatureCurrent === undefined
      ? {}
      : { bodyTemperatureCurrent: finiteNumber(value.bodyTemperatureCurrent) }),
    ...(value.bodyTemperature === undefined
      ? {}
      : { bodyTemperature: numberSeries(value.bodyTemperature) }),
    ...(value.stress === undefined ? {} : { stress: numberSeries(value.stress) }),
    ...(value.stressByHour === undefined ? {} : { stressByHour: numberSeries(value.stressByHour) }),
    ...(value.stressWeekly === undefined ? {} : { stressWeekly: numberSeries(value.stressWeekly) }),
    ...(value.standHours === undefined ? {} : { standHours: finiteNumber(value.standHours) }),
    ...(value.pai === undefined ? {} : { pai: finiteNumber(value.pai) }),
    ...(value.fatBurning === undefined ? {} : { fatBurning: finiteNumber(value.fatBurning) }),
    ...(value.backgroundSamples === undefined
      ? {}
      : {
          backgroundSamples: Array.isArray(value.backgroundSamples)
            ? value.backgroundSamples.map((sample) => {
                if (
                  !isRecord(sample) ||
                  typeof sample.recordedAt !== "string" ||
                  !sample.recordedAt.trim()
                ) {
                  throw new Error("Watch health summary is invalid.");
                }
                return {
                  recordedAt: sample.recordedAt,
                  ...(sample.heartRate === undefined
                    ? {}
                    : { heartRate: finiteNumber(sample.heartRate) }),
                  ...(sample.bloodOxygenPercent === undefined
                    ? {}
                    : { bloodOxygenPercent: finiteNumber(sample.bloodOxygenPercent) }),
                  ...(sample.bodyTemperatureCelsius === undefined
                    ? {}
                    : { bodyTemperatureCelsius: finiteNumber(sample.bodyTemperatureCelsius) }),
                  ...(sample.stress === undefined ? {} : { stress: finiteNumber(sample.stress) }),
                };
              })
            : (() => {
                throw new Error("Watch health summary is invalid.");
              })(),
        }),
  };
}
