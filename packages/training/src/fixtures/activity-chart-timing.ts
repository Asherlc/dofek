/** Server-shaped observations with independent sample rates and an HR interruption. */
const startedAt = Date.parse("2026-10-20T16:00:00Z");

export const activityChartTimingPoints = Array.from({ length: 181 }, (_, index) => ({
  recordedAt: new Date(startedAt + index * 5000).toISOString(),
  heartRate:
    index % 2 === 0 && (index < 60 || index > 90)
      ? Math.round(140 + 15 * Math.sin(index / 15))
      : null,
  power: Math.round(200 + 50 * Math.sin(index / 10)),
  speed: null,
  cadence: null,
  altitude: null,
  lat: null,
  lng: null,
}));
