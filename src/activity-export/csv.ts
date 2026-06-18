import { csvCell, rowsToCsv } from "../export.ts";
import type { ActivityExportInput } from "./types.ts";

export function generateCsv(activity: ActivityExportInput): string {
  const summary = {
    activity_id: activity.id,
    activity_type: activity.activityType,
    name: activity.name,
    started_at: activity.startedAt,
    ended_at: activity.endedAt,
    notes: activity.notes,
    avg_hr: activity.avgHr,
    max_hr: activity.maxHr,
    avg_power: activity.avgPower,
    max_power: activity.maxPower,
    avg_speed: activity.avgSpeed,
    max_speed: activity.maxSpeed,
    avg_cadence: activity.avgCadence,
    total_distance_m: activity.totalDistance,
    elevation_gain_m: activity.elevationGain,
    elevation_loss_m: activity.elevationLoss,
  };

  const streamRows = activity.points.map((point) => ({
    recorded_at: point.recordedAt,
    lat: point.lat,
    lng: point.lng,
    altitude_m: point.altitude,
    heart_rate: point.heartRate,
    power: point.power,
    speed: point.speed,
    cadence: point.cadence,
  }));

  const summarySection = `# activity summary\n${rowsToCsv([summary])}`;
  if (streamRows.length === 0) {
    return summarySection;
  }

  const streamSection = `# stream\n${rowsToCsv(streamRows)}`;
  return `${summarySection}\n\n${streamSection}\n`;
}

export { csvCell };
