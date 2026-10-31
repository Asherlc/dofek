import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as archiveValidation from "../../jobs/validate-import-archive.ts";
import {
  climbingExportZip,
  crimpdSetHeader,
  crimpdWorkoutHeader,
} from "../climbing-file-test-helpers.ts";
import { readCrimpdArchive } from "./archive.ts";

describe("Crimpd ZIP archive", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });
  async function upload(content: Buffer | string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "crimpd-export-"));
    directories.push(directory);
    const path = join(directory, "upload.zip");
    await writeFile(path, content);
    return path;
  }
  it("reads current official CSV members without extracting archive paths", async () => {
    const path = await upload(
      await climbingExportZip({
        "workouts.csv": crimpdWorkoutHeader,
        "sets.csv": crimpdSetHeader,
        "observations.csv": "DATE,ATTRIBUTE,VALUE,UNIT",
      }),
    );
    expect(await readCrimpdArchive(path)).toMatchObject({
      workoutsCsv: crimpdWorkoutHeader,
      setsCsv: crimpdSetHeader,
    });
  });
  it("rejects malformed archives and missing or ambiguous required CSV files", async () => {
    await expect(readCrimpdArchive(await upload("not a ZIP"))).rejects.toThrow(/ZIP/i);
    await expect(
      readCrimpdArchive(await upload(await climbingExportZip({ "sets.csv": crimpdSetHeader }))),
    ).rejects.toThrow(/workouts.csv/i);
    await expect(
      readCrimpdArchive(
        await upload(
          await climbingExportZip({
            "workouts.csv": crimpdWorkoutHeader,
            "a/workouts.csv": crimpdWorkoutHeader,
            "sets.csv": crimpdSetHeader,
          }),
        ),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it("classifies corrupt compressed CSV content even when archive metadata is valid", async () => {
    const archive = await climbingExportZip({
      "workouts.csv": crimpdWorkoutHeader,
      "sets.csv": crimpdSetHeader,
    });
    const compressedDataOffset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
    archive[compressedDataOffset] = 7;
    const path = await upload(archive);
    await expect(archiveValidation.validateImportArchive(path)).resolves.toBeUndefined();
    await expect(readCrimpdArchive(path)).rejects.toMatchObject({
      name: "ClimbingImportValidationError",
      message:
        "Crimpd ZIP contains corrupt or truncated workouts.csv. Download your logbook again from Crimpd and upload the new ZIP.",
    });
  });

  it("preserves unexpected programming and filesystem errors", async () => {
    const programmingFailure = new TypeError("unexpected archive validator failure");
    vi.spyOn(archiveValidation, "validateImportArchive").mockRejectedValueOnce(programmingFailure);
    await expect(readCrimpdArchive("unread.zip")).rejects.toBe(programmingFailure);
    await expect(
      readCrimpdArchive(join(tmpdir(), "missing-crimpd-archive", "missing.zip")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
