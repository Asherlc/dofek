export const MOUNTAIN_PROJECT_TICK_EXPORT_HEADER = [
  "Date",
  "Route",
  "Rating",
  "Notes",
  "URL",
  "Pitches",
  "Location",
  "Avg Stars",
  "Your Stars",
  "Style",
  "Lead Style",
  "Route Type",
  "Your Rating",
  "Length",
  "Rating Code",
] as const;

type MountainProjectTickHeader = (typeof MOUNTAIN_PROJECT_TICK_EXPORT_HEADER)[number];

export interface MountainProjectTick {
  date: string;
  route: string;
  rating: string;
  notes: string;
  url: string;
  pitches: string;
  location: string;
  avgStars: string;
  yourStars: number | null;
  style: string;
  leadStyle: string;
  routeType: string;
  yourRating: string;
  length: string;
  ratingCode: string;
  raw: Record<MountainProjectTickHeader, string>;
}

export type MountainProjectTickExportDecodeResult =
  | { ok: true; ticks: MountainProjectTick[] }
  | { ok: false; message: string };

interface DecodedCsvRow {
  fields: string[];
  rowNumber: number;
}

export function decodeMountainProjectTickExport(
  csvText: string,
): MountainProjectTickExportDecodeResult {
  const decoded = decodeCsv(csvText);
  if (!decoded.ok) return decoded;

  const [header, ...rows] = decoded.rows;
  if (
    !header ||
    header.fields.length !== MOUNTAIN_PROJECT_TICK_EXPORT_HEADER.length ||
    header.fields.some((field, index) => field !== MOUNTAIN_PROJECT_TICK_EXPORT_HEADER[index])
  ) {
    return { ok: false, message: "header does not match Mountain Project tick export format" };
  }

  const ticks: MountainProjectTick[] = [];
  for (const row of rows) {
    if (row.fields.length !== MOUNTAIN_PROJECT_TICK_EXPORT_HEADER.length) {
      return { ok: false, message: `row ${row.rowNumber}: malformed CSV row` };
    }
    const raw: Record<MountainProjectTickHeader, string> = {
      Date: row.fields[0] ?? "",
      Route: row.fields[1] ?? "",
      Rating: row.fields[2] ?? "",
      Notes: row.fields[3] ?? "",
      URL: row.fields[4] ?? "",
      Pitches: row.fields[5] ?? "",
      Location: row.fields[6] ?? "",
      "Avg Stars": row.fields[7] ?? "",
      "Your Stars": row.fields[8] ?? "",
      Style: row.fields[9] ?? "",
      "Lead Style": row.fields[10] ?? "",
      "Route Type": row.fields[11] ?? "",
      "Your Rating": row.fields[12] ?? "",
      Length: row.fields[13] ?? "",
      "Rating Code": row.fields[14] ?? "",
    };
    ticks.push({
      date: raw.Date,
      route: raw.Route,
      rating: raw.Rating,
      notes: raw.Notes,
      url: raw.URL,
      pitches: raw.Pitches,
      location: raw.Location,
      avgStars: raw["Avg Stars"],
      yourStars: parseNullableNumber(raw["Your Stars"]),
      style: raw.Style,
      leadStyle: raw["Lead Style"],
      routeType: raw["Route Type"],
      yourRating: raw["Your Rating"],
      length: raw.Length,
      ratingCode: raw["Rating Code"],
      raw,
    });
  }
  return { ok: true, ticks };
}

function parseNullableNumber(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeCsv(
  csvText: string,
): { ok: true; rows: DecodedCsvRow[] } | { ok: false; message: string } {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: DecodedCsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowNumber = 1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === undefined) continue;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push({ fields: row, rowNumber });
      row = [];
      field = "";
      rowNumber++;
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (inQuotes) return { ok: false, message: `row ${rowNumber}: malformed CSV row` };
  row.push(field);
  rows.push({ fields: row, rowNumber });
  return {
    ok: true,
    rows: rows.filter((entry) => entry.fields.some((fieldValue) => fieldValue !== "")),
  };
}
