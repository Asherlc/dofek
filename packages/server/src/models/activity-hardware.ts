import type { ActivityHardware, ActivityHardwareItem } from "@dofek/providers/activity-hardware";
import { Profile } from "@garmin/fitsdk";
import { z } from "zod";

type Raw = Record<string, unknown>;
export interface ActivityHardwareMember {
  activityId: string;
  providerId: string;
  sourceName: string | null;
  raw: Raw | null;
  observations: { sequence: number; messageType: string; raw: Raw }[];
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function valueText(value: unknown): string | null {
  return (
    text(value) ?? (typeof value === "number" && Number.isFinite(value) ? String(value) : null)
  );
}
function object(value: unknown): Raw {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  return result.success ? result.data : {};
}
function readable(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function readableName(value: string): string {
  return value.includes("_") ? readable(value) : value;
}
function pelotonEquipmentLabel(value: unknown): string | null {
  const code = text(value);
  if (code === null) return null;
  if (code === "home_bike_plus") return "Peloton Bike+";
  if (code === "home_bike_v1" || code === "home_bike") return "Peloton Bike";
  return readable(code);
}
function reportedSourceLabel(value: unknown): string | null {
  const source = text(value);
  if (source === null) return null;
  if (source === "ridewithgps_iphone") return "Ride with GPS for iPhone";
  return source === "watch" ? "Watch" : readableName(source);
}
function enumName(type: string, value: unknown): string | null {
  const name = typeof value === "number" ? Profile.types[type]?.[value] : text(value);
  return name ? readable(name) : null;
}
const fitDeviceFields = z
  .array(
    z.object({
      name: z.string(),
      type: z.string(),
      subFields: z.array(
        z.object({
          type: z.string(),
          map: z.array(z.object({ name: z.string(), value: z.number() })),
        }),
      ),
    }),
  )
  .parse(
    Object.values(
      z
        .record(z.string(), z.unknown())
        .parse(Profile.messages[z.number().parse(Profile.MesgNum.DEVICE_INFO)]?.fields),
    ),
  );
function fitFieldLabel(name: string, raw: Raw): string | null {
  const field = fitDeviceFields.find((field) => field.name === name);
  if (!field) return null;
  const subfield = field.subFields.find((subfield) =>
    subfield.map.some((reference) => raw[reference.name] === reference.value),
  );
  return enumName(subfield?.type ?? field.type, raw[name]);
}
function details(fields: [string, unknown][]): ActivityHardwareItem["details"] {
  return fields.flatMap(([label, value]) => {
    const rendered = valueText(value);
    return rendered === null ? [] : [{ label, value: rendered }];
  });
}
function base(member: ActivityHardwareMember, suffix: string) {
  return {
    id: `${member.activityId}:${suffix}`,
    activityId: member.activityId,
    providerId: member.providerId,
    sourceName: member.sourceName === null ? null : readableName(member.sourceName),
  };
}
function compatibleIdentity(left: Raw, right: Raw): boolean {
  return ["manufacturer", "serialNumber", "product", "productName", "deviceType"].every((field) => {
    const first = valueText(left[field]);
    const second = valueText(right[field]);
    return first === null || second === null || first === second;
  });
}
function fitItems(member: ActivityHardwareMember): ActivityHardwareItem[] {
  const groups = new Map<string, Raw>();
  const indexGroups = new Map<string, string>();
  for (const observation of [...member.observations].sort((a, b) => a.sequence - b.sequence)) {
    const raw = Object.fromEntries(
      Object.entries(observation.raw).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
    const index = valueText(raw.deviceIndex);
    const serial = valueText(raw.serialNumber);
    const manufacturer = valueText(raw.manufacturer);
    let key = `observation:${observation.sequence}`;
    if (observation.messageType === "file_id") {
      key = "creator";
    } else if (index !== null) {
      const indexedKey = indexGroups.get(index);
      const indexed = indexedKey ? groups.get(indexedKey) : undefined;
      const creator = groups.get("creator");
      if (indexedKey && indexed && compatibleIdentity(indexed, raw)) key = indexedKey;
      else if (!indexedKey && index === "0" && creator && compatibleIdentity(creator, raw))
        key = "creator";
      else key = indexedKey ? `index:${index}:${observation.sequence}` : `index:${index}`;
      indexGroups.set(index, key);
    } else if (serial !== null && manufacturer !== null) {
      const matches = [...groups].filter(
        ([, item]) =>
          valueText(item.serialNumber) === serial &&
          valueText(item.manufacturer) === manufacturer &&
          compatibleIdentity(item, raw),
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match) key = match[0];
    }
    const previous = groups.get(key) ?? {};
    for (const [field, value] of Object.entries(raw)) {
      if (value !== null && value !== undefined && value !== "") previous[field] = value;
    }
    groups.set(key, previous);
  }
  return [...groups].map(([key, raw]) => {
    const manufacturer = enumName("manufacturer", raw.manufacturer);
    const product = raw.garminProduct ?? raw.product;
    const model = text(raw.productName) ?? fitFieldLabel("product", raw);
    const role =
      key === "creator" || valueText(raw.deviceIndex) === "0"
        ? "creator"
        : raw.deviceIndex !== undefined
          ? "sensor"
          : "unknown";
    const deviceType = fitFieldLabel("deviceType", raw);
    return {
      ...base(member, key),
      role,
      label: readableName(model ?? deviceType ?? manufacturer ?? "Unidentified device"),
      model: model === null ? null : readableName(model),
      manufacturer: manufacturer === null ? null : readableName(manufacturer),
      evidence:
        role === "creator"
          ? "FIT file creator; may be an export platform rather than the original recording device."
          : "Observed in the FIT file; this does not identify the source of every sample.",
      details: details([
        ["Serial number", raw.serialNumber],
        ["Device index", raw.deviceIndex],
        ["Manufacturer code", manufacturer === null ? raw.manufacturer : null],
        ["Product code", model === null ? product : null],
        ["Connection", enumName("sourceType", raw.sourceType)],
        ["Device type", deviceType],
        ["Firmware", raw.softwareVersion],
        ["Hardware", raw.hardwareVersion],
        ["Battery", enumName("batteryStatus", raw.batteryStatus)],
        [
          "Battery voltage",
          typeof raw.batteryVoltage === "number" ? `${raw.batteryVoltage} V` : null,
        ],
        ["ANT device number", raw.antDeviceNumber],
      ]),
    };
  });
}
function apiItem(member: ActivityHardwareMember): ActivityHardwareItem | null {
  const raw = member.raw ?? {};
  let label: string | null = null;
  let model: string | null = null;
  let manufacturer: string | null = null;
  let role: ActivityHardwareItem["role"] = "recorder";
  let evidence = "Recording device reported by the provider.";
  let itemDetails: ActivityHardwareItem["details"] = [];
  if (member.providerId === "strava") label = text(raw.device_name);
  if (member.providerId === "garmin") {
    const deviceName = text(raw.deviceName);
    label = deviceName === "unknown" ? null : deviceName;
  }
  if (member.providerId === "polar") {
    label = text(raw.device);
    itemDetails = details([["Device ID", raw.device_id]]);
  }
  if (member.providerId === "apple_health" || member.providerId === "apple-health") {
    const device = object(raw.device);
    model = text(device.model);
    manufacturer = text(device.manufacturer);
    label = text(device.name) ?? model ?? manufacturer;
    itemDetails = details([
      ["Hardware", device.hardwareVersion],
      ["Firmware", device.firmwareVersion],
      ["Software", device.softwareVersion],
      ["Local identifier", device.localIdentifier],
      ["UDI", device.udiDeviceIdentifier],
    ]);
    evidence = "Hardware reported by HealthKit; the source app is separate.";
  }
  if (member.providerId === "peloton") {
    role = "category";
    label = pelotonEquipmentLabel(raw.deviceType) ?? pelotonEquipmentLabel(raw.platform);
    evidence = "Reported equipment category or platform; exact model unavailable.";
    itemDetails = details([["Platform", pelotonEquipmentLabel(raw.platform)]]);
  }
  if (member.providerId === "ride-with-gps") {
    role = "source";
    label = reportedSourceLabel(raw.source);
    evidence = "Reported source or import app; original recording hardware is not established.";
  }
  if (member.providerId === "amazfit-zepp") {
    role = "source";
    label = reportedSourceLabel(raw.source) ?? reportedSourceLabel(raw.app_name);
    evidence = "Reported source or app; original recording hardware is not established.";
    itemDetails = details([["App", reportedSourceLabel(raw.app_name)]]);
  }
  if (!label && itemDetails.length) label = "Unidentified device";
  if (!label) return null;
  return {
    ...base(member, "api"),
    role,
    label: readableName(label),
    model: model === null ? null : readableName(model),
    manufacturer: manufacturer === null ? null : readableName(manufacturer),
    evidence,
    details: itemDetails,
  };
}
export function normalizeActivityHardware(members: ActivityHardwareMember[]): ActivityHardware {
  return {
    items: members.flatMap((member) => {
      const fit = fitItems(member);
      const api = apiItem(member);
      return api ? [...fit, api] : fit;
    }),
    power: members.flatMap((member) => {
      const watts = member.raw?.device_watts;
      return member.providerId === "strava" && typeof watts === "boolean"
        ? [
            {
              activityId: member.activityId,
              providerId: member.providerId,
              kind: watts ? ("measured" as const) : ("estimated" as const),
              label: watts ? "Power · Measured · Strava" : "Power · Estimated · Strava",
            },
          ]
        : [];
    }),
  };
}
