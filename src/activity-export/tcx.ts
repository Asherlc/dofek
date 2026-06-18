import { tcxSport } from "./sports.ts";
import type { ActivityExportInput, ActivityExportPoint } from "./types.ts";
import { escapeXml } from "./xml.ts";

function formatTrackpoint(point: ActivityExportPoint): string {
  const lines = [`          <Trackpoint>`, `            <Time>${point.recordedAt}</Time>`];

  if (point.lat != null && point.lng != null) {
    lines.push("            <Position>");
    lines.push(`              <LatitudeDegrees>${point.lat}</LatitudeDegrees>`);
    lines.push(`              <LongitudeDegrees>${point.lng}</LongitudeDegrees>`);
    lines.push("            </Position>");
  }

  if (point.altitude != null) {
    lines.push(`            <AltitudeMeters>${point.altitude}</AltitudeMeters>`);
  }
  if (point.heartRate != null) {
    lines.push("            <HeartRateBpm>");
    lines.push(`              <Value>${Math.round(point.heartRate)}</Value>`);
    lines.push("            </HeartRateBpm>");
  }
  if (point.cadence != null) {
    lines.push(`            <Cadence>${Math.round(point.cadence)}</Cadence>`);
  }
  if (point.speed != null) {
    lines.push(`            <Extensions>`);
    lines.push(`              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">`);
    lines.push(`                <Speed>${point.speed}</Speed>`);
    if (point.power != null) {
      lines.push(`                <Watts>${Math.round(point.power)}</Watts>`);
    }
    lines.push(`              </TPX>`);
    lines.push(`            </Extensions>`);
  } else if (point.power != null) {
    lines.push(`            <Extensions>`);
    lines.push(`              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">`);
    lines.push(`                <Watts>${Math.round(point.power)}</Watts>`);
    lines.push(`              </TPX>`);
    lines.push(`            </Extensions>`);
  }

  lines.push("          </Trackpoint>");
  return lines.join("\n");
}

function resolveEndTime(activity: ActivityExportInput): string {
  if (activity.endedAt) return activity.endedAt;
  const lastPoint = activity.points.at(-1);
  if (lastPoint) return lastPoint.recordedAt;
  return activity.startedAt;
}

function elapsedSeconds(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return Math.max(0, (end.getTime() - start.getTime()) / 1000);
}

function formatLapMetadata(activity: ActivityExportInput, lapStart: string): string {
  const lines = [
    `        <TotalTimeSeconds>${elapsedSeconds(lapStart, resolveEndTime(activity))}</TotalTimeSeconds>`,
    `        <DistanceMeters>${activity.totalDistance ?? 0}</DistanceMeters>`,
  ];

  if (activity.maxSpeed != null) {
    lines.push(`        <MaximumSpeed>${activity.maxSpeed}</MaximumSpeed>`);
  }
  if (activity.avgHr != null) {
    lines.push("        <AverageHeartRateBpm>");
    lines.push(`          <Value>${Math.round(activity.avgHr)}</Value>`);
    lines.push("        </AverageHeartRateBpm>");
  }
  if (activity.maxHr != null) {
    lines.push("        <MaximumHeartRateBpm>");
    lines.push(`          <Value>${Math.round(activity.maxHr)}</Value>`);
    lines.push("        </MaximumHeartRateBpm>");
  }

  return lines.join("\n");
}

export function generateTcx(activity: ActivityExportInput): string {
  const trackpoints = activity.points.map(formatTrackpoint).join("\n");
  const sport = tcxSport(activity.activityType);
  const activityName = escapeXml(activity.name ?? activity.activityType);
  const lapStart = activity.startedAt;
  const notesLine = activity.name != null ? `      <Notes>${activityName}</Notes>\n` : "";
  const lapMetadata = formatLapMetadata(activity, lapStart);

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${activity.startedAt}</Id>
${notesLine}      <Lap StartTime="${lapStart}">
${lapMetadata}
        <Track>
${trackpoints}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}
