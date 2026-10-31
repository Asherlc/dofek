import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";

export const eightAHeader =
  "route_boulder,name,location_name,sector_name,area_name,country_code,date,type,sub_type,rating,project,tries,repeats,difficulty,perceived_hardness,comment,height,recommended,sits";
export const moonBoardHeader =
  "board,angle,climb_name,date,logged_grade,displayed_grade,is_benchmark,tries,is_mirror,sessions_count,tries_total,is_repeat,is_ascent,comment";
export const crimpdWorkoutHeader =
  "DATE,WORKOUT_NAME,TYPE,TARGET,WORKLOAD,INTENSITY,COMPLETION,EST_DURATION,WEIGHT_UNIT,AVG_GRADE,LENGTH_UNIT,LB_CIRCUIT,LB_ANGLE,NOTES,LOG_ID";
export const crimpdSetHeader =
  "LOG_ID,DATE,EXERCISE,ACTIVITY_ORDER,ACTIVITY_NOTES,SET_ORDER,NAME,GRADE,GRADE_SYSTEM,REPS,ASCENT,COMPLETE,EST_WORK_DURATION,EST_REST_DURATION,INTENSITY,RESISTANCE,WEIGHT_UNIT,ANGLE,LB_CIRCUIT,DISTANCE,LENGTH_UNIT,LOCATION,BOARD,BOARD_LAYOUT,WALL_ANGLE,CLIMB_STYLE,LENGTH,HOLD_TYPE,LOCATION_NAME,OTHER_TAGS,NOTES";

export function csvRow(header: string, values: Record<string, string>): string {
  return header
    .split(",")
    .map((key) => {
      const value = values[key] ?? "";
      return /[,"\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    })
    .join(",");
}

export function eightARow(values: Record<string, string> = {}): string {
  return csvRow(eightAHeader, {
    route_boulder: "BOULDER",
    name: "A boulder",
    date: "2026-09-01T23:30:00Z",
    type: "rp",
    tries: "0",
    difficulty: "7A",
    location_name: "Example Forest",
    country_code: "FR",
    ...values,
  });
}

export function moonBoardRow(values: Record<string, string> = {}): string {
  return csvRow(moonBoardHeader, {
    board: "moon2019",
    angle: "40",
    climb_name: "Benchmark",
    date: "2026-09-01",
    logged_grade: "6C+",
    displayed_grade: "7A",
    is_benchmark: "True",
    tries: "4+",
    is_mirror: "False",
    ...values,
  });
}

export function crimpdWorkoutRow(values: Record<string, string> = {}): string {
  return csvRow(crimpdWorkoutHeader, {
    DATE: "2026-09-01T23:30:00Z",
    WORKOUT_NAME: "Board climbing",
    TYPE: "Open Climbing",
    TARGET: "Bouldering",
    WORKLOAD: "500",
    INTENSITY: "0",
    EST_DURATION: "3600",
    WEIGHT_UNIT: "KG",
    LENGTH_UNIT: "CM",
    LOG_ID: "workout-1",
    ...values,
  });
}

export function crimpdSetRow(values: Record<string, string> = {}): string {
  return csvRow(crimpdSetHeader, {
    LOG_ID: "workout-1",
    DATE: "2026-09-01T23:30:00Z",
    EXERCISE: "Board bouldering",
    ACTIVITY_ORDER: "1",
    SET_ORDER: "1",
    NAME: "A problem",
    GRADE: "7A",
    GRADE_SYSTEM: "FONT",
    REPS: "3",
    ASCENT: "false",
    COMPLETE: "true",
    EST_WORK_DURATION: "30",
    EST_REST_DURATION: "90",
    LOCATION: "board",
    BOARD: "kilter_board",
    BOARD_LAYOUT: "original",
    ANGLE: "0",
    ...values,
  });
}

export async function climbingExportZip(files: Record<string, string>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  archive.pipe(output);
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.once("end", () => resolve(Buffer.concat(chunks)));
    output.once("error", reject);
    archive.once("error", reject);
  });
  for (const [name, contents] of Object.entries(files)) archive.append(contents, { name });
  await archive.finalize();
  return completed;
}
