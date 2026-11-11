import { basename } from "node:path";
import { text } from "node:stream/consumers";
import yauzl from "yauzl";
import {
  ArchiveValidationError,
  validateImportArchive,
} from "../../jobs/validate-import-archive.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";

function csvReadFailure(error: unknown, filename: string): unknown {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "Z_DATA_ERROR" || error.code === "Z_BUF_ERROR")
  ) {
    return new ClimbingImportValidationError(
      `Crimpd ZIP contains corrupt or truncated ${filename}. Download your logbook again from Crimpd and upload the new ZIP.`,
      { cause: error },
    );
  }
  return error;
}

/** Read only recognized CSV files; shared ZIP validation checks paths and expanded sizes. */
export async function readCrimpdArchive(
  filePath: string,
): Promise<{ workoutsCsv: string; setsCsv: string }> {
  try {
    await validateImportArchive(filePath);
  } catch (error) {
    if (error instanceof ArchiveValidationError)
      throw new ClimbingImportValidationError(error.message, { cause: error });
    throw error;
  }
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) {
        reject(error ?? new Error("Crimpd ZIP could not be opened"));
        return;
      }
      resolve(archive);
    });
  });
  const members = new Map<string, string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once("error", reject);
      zip.once("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = basename(entry.fileName);
        if (name !== "workouts.csv" && name !== "sets.csv") {
          zip.readEntry();
          return;
        }
        if (members.has(name)) {
          reject(new ClimbingImportValidationError(`Crimpd ZIP contains duplicate ${name}`));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error("Crimpd ZIP member could not be read"));
            return;
          }
          void text(stream).then(
            (contents) => {
              members.set(name, contents);
              zip.readEntry();
            },
            (error: unknown) => reject(csvReadFailure(error, name)),
          );
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  const workoutsCsv = members.get("workouts.csv");
  const setsCsv = members.get("sets.csv");
  if (workoutsCsv === undefined || setsCsv === undefined)
    throw new ClimbingImportValidationError(
      "Crimpd ZIP must contain workouts.csv and sets.csv. Download a current logbook export from Crimpd.",
    );
  return { workoutsCsv, setsCsv };
}
