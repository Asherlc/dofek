import type { ActivityExportInput, ActivityExportPoint } from "./types.ts";
import { escapeXml } from "./xml.ts";

function formatTrackpoint(point: ActivityExportPoint): string {
  if (point.lat == null || point.lng == null) return "";

  const lines = [
    `      <trkpt lat="${point.lat}" lon="${point.lng}">`,
    point.altitude != null ? `        <ele>${point.altitude}</ele>` : null,
    `        <time>${point.recordedAt}</time>`,
  ];

  const extensions: string[] = [];
  if (point.heartRate != null) {
    extensions.push(`          <gpxtpx:hr>${Math.round(point.heartRate)}</gpxtpx:hr>`);
  }
  if (point.cadence != null) {
    extensions.push(`          <gpxtpx:cad>${Math.round(point.cadence)}</gpxtpx:cad>`);
  }
  if (point.power != null) {
    extensions.push(`          <power>${Math.round(point.power)}</power>`);
  }
  if (point.speed != null) {
    extensions.push(`          <speed>${point.speed}</speed>`);
  }

  if (extensions.length > 0) {
    lines.push("        <extensions>");
    lines.push(
      '          <gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
    );
    lines.push(...extensions);
    lines.push("          </gpxtpx:TrackPointExtension>");
    lines.push("        </extensions>");
  }

  lines.push("      </trkpt>");
  return lines.filter((line): line is string => line != null).join("\n");
}

export function generateGpx(activity: ActivityExportInput): string {
  const trackpoints = activity.points
    .map(formatTrackpoint)
    .filter((segment) => segment.length > 0)
    .join("\n");
  const trackName = escapeXml(activity.name ?? activity.activityType);

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Dofek" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>${trackName}</name>
    <time>${activity.startedAt}</time>
  </metadata>
  <trk>
    <name>${trackName}</name>
    <type>${escapeXml(activity.activityType)}</type>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>
`;
}

export function hasGpsPoints(activity: ActivityExportInput): boolean {
  return activity.points.some((point) => point.lat != null && point.lng != null);
}
