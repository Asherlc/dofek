/// <reference path="./garmin-fitsdk.d.ts" />
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { fitSport } from "./sports.ts";
import type { ActivityExportInput, ActivityExportPoint } from "./types.ts";

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

function degreesToSemicircles(degrees: number): number {
  return Math.round(degrees * SEMICIRCLES_PER_DEGREE);
}

function elapsedSeconds(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const haversineIntermediate =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return (
    earthRadiusMeters *
    2 *
    Math.atan2(Math.sqrt(haversineIntermediate), Math.sqrt(1 - haversineIntermediate))
  );
}

function buildRecordMessage(
  point: ActivityExportPoint,
  fitTimestamp: number,
  distance: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    mesgNum: Profile.MesgNum.RECORD,
    timestamp: fitTimestamp,
    distance,
  };

  if (point.heartRate != null) message.heartRate = Math.round(point.heartRate);
  if (point.power != null) message.power = Math.round(point.power);
  if (point.cadence != null) message.cadence = Math.round(point.cadence);
  if (point.speed != null) message.enhancedSpeed = point.speed;
  if (point.altitude != null) message.enhancedAltitude = point.altitude;
  if (point.lat != null) message.positionLat = degreesToSemicircles(point.lat);
  if (point.lng != null) message.positionLong = degreesToSemicircles(point.lng);

  return message;
}

export function generateFit(activity: ActivityExportInput): Buffer {
  const startDate = new Date(activity.startedAt);
  const fallbackEnd = activity.points.at(-1)?.recordedAt;
  const endDate = activity.endedAt
    ? new Date(activity.endedAt)
    : fallbackEnd
      ? new Date(fallbackEnd)
      : startDate;
  const startTime = Utils.convertDateToDateTime(startDate);
  const endTime = Utils.convertDateToDateTime(endDate);
  const totalElapsedTime = Math.max(1, elapsedSeconds(startDate, endDate));
  const sport = fitSport(activity.activityType);
  const encoder = new Encoder();

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: startTime,
  });

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.DEVICE_INFO,
    deviceIndex: "creator",
    manufacturer: "development",
    product: 0,
    productName: "Dofek",
    timestamp: startTime,
  });

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.EVENT,
    timestamp: startTime,
    event: "timer",
    eventType: "start",
  });

  const points =
    activity.points.length > 0
      ? activity.points
      : [
          {
            recordedAt: activity.startedAt,
            heartRate: activity.avgHr,
            power: activity.avgPower,
            speed: activity.avgSpeed,
            cadence: activity.avgCadence,
            altitude: null,
            lat: null,
            lng: null,
          },
        ];

  let cumulativeDistance = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    if (index > 0) {
      const previous = points[index - 1];
      if (previous?.lat != null && previous.lng != null && point.lat != null && point.lng != null) {
        cumulativeDistance += haversineMeters(previous.lat, previous.lng, point.lat, point.lng);
      }
    }
    const pointDate = new Date(point.recordedAt);
    const fitTimestamp = Utils.convertDateToDateTime(pointDate);
    encoder.writeMesg(buildRecordMessage(point, fitTimestamp, cumulativeDistance));
  }

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.EVENT,
    timestamp: endTime,
    event: "timer",
    eventType: "stop",
  });

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.LAP,
    messageIndex: 0,
    timestamp: endTime,
    startTime,
    totalElapsedTime,
    totalTimerTime: totalElapsedTime,
    totalDistance: activity.totalDistance ?? cumulativeDistance,
  });

  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    messageIndex: 0,
    timestamp: endTime,
    startTime,
    totalElapsedTime,
    totalTimerTime: totalElapsedTime,
    sport,
    subSport: "generic",
    firstLapIndex: 0,
    numLaps: 1,
    totalDistance: activity.totalDistance ?? cumulativeDistance,
    avgHeartRate: activity.avgHr != null ? Math.round(activity.avgHr) : undefined,
    maxHeartRate: activity.maxHr != null ? Math.round(activity.maxHr) : undefined,
    avgPower: activity.avgPower != null ? Math.round(activity.avgPower) : undefined,
    maxPower: activity.maxPower != null ? Math.round(activity.maxPower) : undefined,
    avgCadence: activity.avgCadence != null ? Math.round(activity.avgCadence) : undefined,
  });

  const localTimestampOffset = endDate.getTimezoneOffset() * -60;
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.ACTIVITY,
    timestamp: endTime,
    numSessions: 1,
    localTimestamp: endTime + localTimestampOffset,
    totalTimerTime: totalElapsedTime,
  });

  return Buffer.from(encoder.close());
}
