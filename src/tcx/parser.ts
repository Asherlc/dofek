import sax from "sax";
import type { SensorSampleSourceRow } from "../db/sensor-sample-writer.ts";

export interface TcxTrackpoint {
  recordedAt: Date;
  lat?: number;
  lng?: number;
  altitude?: number;
  heartRate?: number;
  cadence?: number;
  speed?: number;
  power?: number;
}

/**
 * Parse a TCX file buffer into an array of trackpoints.
 * Extracts GPS coordinates, altitude, heart rate, cadence, speed, and power.
 */
export function parseTcx(buffer: Buffer | string): TcxTrackpoint[] {
  const xml = typeof buffer === "string" ? buffer : buffer.toString("utf-8");
  const parser = sax.parser(false, { lowercase: true });
  const trackpoints: TcxTrackpoint[] = [];

  let inTrackpoint = false;
  let currentElement = "";
  let parentElement = "";
  let currentPoint: Partial<TcxTrackpoint> = {};

  parser.onopentag = (node) => {
    const tag = node.name;
    if (tag === "trackpoint") {
      inTrackpoint = true;
      currentPoint = {};
    }
    if (inTrackpoint) {
      if (tag === "position" || tag === "heartratebpm" || tag === "extensions") {
        parentElement = tag;
      }
      currentElement = tag;
    }
  };

  parser.ontext = (text) => {
    if (!inTrackpoint) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    switch (currentElement) {
      case "time":
        currentPoint.recordedAt = new Date(trimmed);
        break;
      case "latitudedegrees":
        currentPoint.lat = parseFloat(trimmed);
        break;
      case "longitudedegrees":
        currentPoint.lng = parseFloat(trimmed);
        break;
      case "altitudemeters":
        currentPoint.altitude = parseFloat(trimmed);
        break;
      case "value":
        if (parentElement === "heartratebpm") {
          currentPoint.heartRate = parseInt(trimmed, 10);
        }
        break;
      case "cadence":
        currentPoint.cadence = parseInt(trimmed, 10);
        break;
      case "watts":
        currentPoint.power = parseInt(trimmed, 10);
        break;
      case "speed":
        currentPoint.speed = parseFloat(trimmed);
        break;
    }
  };

  parser.onclosetag = (tag) => {
    if (tag === "trackpoint" && inTrackpoint) {
      if (currentPoint.recordedAt) {
        trackpoints.push({
          recordedAt: currentPoint.recordedAt,
          lat: currentPoint.lat,
          lng: currentPoint.lng,
          altitude: currentPoint.altitude,
          heartRate: currentPoint.heartRate,
          cadence: currentPoint.cadence,
          speed: currentPoint.speed,
          power: currentPoint.power,
        });
      }
      inTrackpoint = false;
      currentPoint = {};
      parentElement = "";
    }
    if (tag === "position" || tag === "heartratebpm" || tag === "extensions") {
      parentElement = "";
    }
    currentElement = "";
  };

  parser.write(xml).close();
  return trackpoints;
}

/**
 * Convert TCX trackpoints to sensor sample source rows for insertion.
 */
export function tcxToSensorSamples(
  trackpoints: TcxTrackpoint[],
  providerId: string,
  activityId: string,
): SensorSampleSourceRow[] {
  return trackpoints.map((point) => ({
    providerId,
    activityId,
    recordedAt: point.recordedAt,
    heartRate: point.heartRate,
    power: point.power,
    cadence: point.cadence,
    speed: point.speed,
    lat: point.lat,
    lng: point.lng,
    altitude: point.altitude,
  }));
}
