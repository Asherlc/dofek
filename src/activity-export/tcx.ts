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

export function generateTcx(activity: ActivityExportInput): string {
  const trackpoints = activity.points.map(formatTrackpoint).join("\n");
  const sport = tcxSport(activity.activityType);
  const activityName = escapeXml(activity.name ?? activity.activityType);
  const lapStart = activity.startedAt;

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${activity.startedAt}</Id>
      <Name>${activityName}</Name>
      <Lap StartTime="${lapStart}">
        <Track>
${trackpoints}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}
