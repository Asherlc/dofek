import { UnitConverter } from "@dofek/format/units";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";

export const points = [
  {
    recordedAt: "2026-10-18T17:30:00Z",
    heartRate: 140,
    power: 200,
    speed: 8,
    cadence: 80,
    altitude: 200,
    lat: null,
    lng: null,
  },
  {
    recordedAt: "2026-10-18T17:31:00Z",
    heartRate: 150,
    power: 220,
    speed: 9,
    cadence: 85,
    altitude: 205,
    lat: null,
    lng: null,
  },
] satisfies [StreamPoint, StreamPoint];

export const args = {
  points,
  activityType: "cycling",
  hasHr: true,
  hasPower: true,
  hasSpeed: true,
  hasCadence: true,
  loading: false,
  units: new UnitConverter("metric"),
};

export const skinTemperaturePoints = [
  { ...points[0], skinTemperature: 32.18, skinTemperatureRecordedAt: "2026-10-18T17:29:00Z" },
  { ...points[1], skinTemperature: 32.4, skinTemperatureRecordedAt: "2026-10-18T17:31:17Z" },
  { ...points[1], skinTemperature: null, skinTemperatureRecordedAt: "2026-10-18T17:20:00Z" },
];

export const zoomClimbAnnotations = [
  { id: "first", label: "First", startedAt: points[0].recordedAt, endedAt: null },
  { id: "middle", label: "Middle", startedAt: "2026-10-18T17:30:30Z", endedAt: null },
  {
    id: "range",
    label: "Range",
    startedAt: "2026-10-18T17:30:45Z",
    endedAt: points[1].recordedAt,
  },
];

export const highlightClimbAnnotations = [
  { id: "first", label: "First", startedAt: "2026-10-18T17:30:20Z", endedAt: null },
  { id: "repeat", label: "Repeat", startedAt: "2026-10-18T17:30:40Z", endedAt: null },
  {
    id: "range",
    label: "Range",
    startedAt: "2026-10-18T17:30:00Z",
    endedAt: "2026-10-18T17:30:30Z",
  },
];

export const timedClimbAnnotations = [
  { id: "ascent", label: "Corner · V3", startedAt: "2026-10-18T17:30:20Z", endedAt: null },
  {
    id: "range",
    label: "Arete · V4",
    startedAt: "2026-10-18T17:29:00Z",
    endedAt: "2026-10-18T17:30:40Z",
  },
  { id: "outside", label: "Outside", startedAt: "2026-10-18T17:32:00Z", endedAt: null },
];

export const selectableClimbAnnotations = [
  { id: "first", label: "Same route", startedAt: points[0].recordedAt, endedAt: null },
  { id: "repeat", label: "Same route", startedAt: points[1].recordedAt, endedAt: null },
  {
    id: "range",
    label: "Timed route",
    startedAt: points[0].recordedAt,
    endedAt: points[1].recordedAt,
  },
];

export const watchReadings = new Map([
  [7, 80],
  [67, 100],
  [97, 110],
  [154, 120],
  [186, 125],
  [223, 130],
  [252, 135],
  [297, 140],
  [314, 145],
  [335, 150],
  [376, 155],
  [396, 120],
  [464, 100],
]);
